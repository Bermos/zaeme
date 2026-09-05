#!/usr/bin/env bash
#
# Exercise the machine API (`/api/v1`) against a RUNNING zäme with a real
# database. `pnpm test` proves the route tree and the contract describe the same
# surface; this proves the routes actually answer, with the shapes and the status
# codes the contract promises — and, most importantly, that the three
# credentials cannot reach each other's surfaces.
#
# A contract test that only checks route existence is much weaker than one that
# confirms a real request returns the shape the spec promises. This is the
# second half.
#
# Usage:
#
#   # 1. a Postgres, migrated
#   docker run -d --name zaeme-pg -p 5432:5432 \
#     -e POSTGRES_USER=zaeme -e POSTGRES_PASSWORD=zaeme -e POSTGRES_DB=zaeme postgres:17-alpine
#   DATABASE_URL=postgres://zaeme:zaeme@127.0.0.1:5432/zaeme node scripts/migrate.mjs
#
#   # 2. an owner account (the machine API acts as the instance owner)
#   psql "$DATABASE_URL" -c "insert into zaeme_user (id,name,email,email_verified)
#     values ('owner_1','Owner','owner@example.com',true) on conflict do nothing;"
#
#   # 3. the built server
#   pnpm build
#   DATABASE_URL=... ZAEME_SERVICE_TOKEN=dev-token ZAEME_ENTERPRISE_OWNER_ID=ent_owner \
#     BASE_URL=http://127.0.0.1:3111 PORT=3111 node .output/server/index.mjs &
#
#   # 4. this
#   BASE_URL=http://127.0.0.1:3111 ZAEME_SERVICE_TOKEN=dev-token \
#     ZAEME_ENTERPRISE_OWNER_ID=ent_owner ./scripts/api-smoke.sh
#
# Object storage is optional: set S3_* and the poster checks run against it,
# otherwise they are skipped and say so.
set -uo pipefail

BASE="${BASE_URL:-http://127.0.0.1:3111}"
TOKEN="${ZAEME_SERVICE_TOKEN:?ZAEME_SERVICE_TOKEN is required}"
OWNER="${ZAEME_ENTERPRISE_OWNER_ID:?ZAEME_ENTERPRISE_OWNER_ID is required}"

PASS=0
FAIL=0

# `check <name> <expected-status> <curl args...>`
check() {
  local name="$1" want="$2"; shift 2
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' "$@")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %-58s %s\n' "$name" "$got"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %-58s want %s got %s\n' "$name" "$want" "$got"
  fi
}

# `body <curl args...>` — the response body, for shape assertions.
body() { curl -s "$@"; }

contains() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*) PASS=$((PASS + 1)); printf '  ok   %-58s\n' "$name" ;;
    *) FAIL=$((FAIL + 1)); printf '  FAIL %-58s missing %s\n' "$name" "$needle"; printf '       got: %.200s\n' "$haystack" ;;
  esac
}

AUTH=(-H "Authorization: Bearer $TOKEN" -H "x-mcp-user: $OWNER")
# The four provenance headers Enterprise stamps. zäme does nothing with them
# yet; accepting them without erroring is what keeps the lineage option open.
PROV=(-H "x-mcp-thread: thr_smoke" -H "x-mcp-model: claude-opus-5" -H "x-mcp-basis: msg_a,msg_b")
JSON=(-H 'content-type: application/json')
API="$BASE/api/v1"

echo "== the contract is served =="
check "GET /api/openapi.yaml"                    200 "$BASE/api/openapi.yaml"
contains "it is the source-of-truth copy" "$(body "$BASE/api/openapi.yaml")" 'SOURCE OF TRUTH'

echo
echo "== authentication =="
check "getHealth needs no credential"            200 "$API/health"
check "no token"                                 401 "$API/events"
check "wrong token"                              401 -H 'Authorization: Bearer wrong' -H "x-mcp-user: $OWNER" "$API/events"
check "right token, no x-mcp-user"               401 -H "Authorization: Bearer $TOKEN" "$API/events"
check "right token, unknown owner"               403 -H "Authorization: Bearer $TOKEN" -H 'x-mcp-user: nobody' "$API/events"
check "right token, right owner"                 200 "${AUTH[@]}" "$API/events"
check "provenance headers are accepted"          200 "${AUTH[@]}" "${PROV[@]}" "$API/events"

# A missing token and a wrong token must be INDISTINGUISHABLE.
A=$(body -o /dev/null -w '%{http_code}' "$API/events")
B=$(body -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' "$API/events")
NOBODY=$(body "$API/events"); WRONG=$(body -H 'Authorization: Bearer wrong' "$API/events")
# The request id differs by construction; everything else must match.
NOBODY_E=$(printf '%s' "$NOBODY" | sed 's/"requestId":"[^"]*"//')
WRONG_E=$(printf '%s' "$WRONG" | sed 's/"requestId":"[^"]*"//')
if [ "$A" = "$B" ] && [ "$NOBODY_E" = "$WRONG_E" ]; then
  PASS=$((PASS + 1)); printf '  ok   %-58s\n' "missing and wrong token are indistinguishable"
else
  FAIL=$((FAIL + 1)); printf '  FAIL %-58s\n' "missing and wrong token differ"
fi

echo
echo "== the boundary: a service token must not reach the human surfaces =="
check "service token on /api/host (GET)"         401 "${AUTH[@]}" "$BASE/api/host/events"
check "service token on /api/host (POST)"        401 "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events" -d '{"title":"Smuggled"}'
check "service token on /api/me"                 401 "${AUTH[@]}" "$BASE/api/me/invites"
check "service token is not an invite token"     404 "${AUTH[@]}" "$BASE/api/invites/$TOKEN"

echo
echo "== the boundary: a guest session must not reach /api/v1 =="
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  COOKIE=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  check "the session is genuinely valid (control)" 200 "${COOKIE[@]}" "$BASE/api/host/events"
  check "same session on /api/v1/events"           401 "${COOKIE[@]}" "$API/events"
  check "same session on /api/v1/snapshot"         401 "${COOKIE[@]}" "$API/snapshot"
  check "session + x-mcp-user, no bearer"          401 "${COOKIE[@]}" -H "x-mcp-user: $OWNER" "$API/events"
  check "session + a WRONG bearer"                 401 "${COOKIE[@]}" -H 'Authorization: Bearer wrong' -H "x-mcp-user: $OWNER" "$API/events"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE='better-auth.session_token=<value>' to run these"
  echo "        (sign in via the magic link, then copy the Set-Cookie value)"
fi

echo
echo "== events, invites, RSVPs =="
SUFFIX=$(date +%s)
EV=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
  -d "{\"title\":\"Smoke roast $SUFFIX\",\"type\":\"hosted\",\"startsAt\":\"2027-03-01T18:00:00+01:00\",\"location\":\"Bern\"}")
SLUG=$(printf '%s' "$EV" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
contains "createEvent returns an EventRef"       "$EV" '"slug"'
echo "  event: $SLUG"
check "getEvent"                                 200 "${AUTH[@]}" "$API/events/$SLUG"
contains "getEvent carries the planner team"     "$(body "${AUTH[@]}" "$API/events/$SLUG")" '"planners"'
check "updateEvent"                              200 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$API/events/$SLUG" -d '{"description":"smoke"}'
check "updateEvent rejects an unknown field"     422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$API/events/$SLUG" -d '{"nope":1}'
check "getEvent on a missing slug"               404 "${AUTH[@]}" "$API/events/no-such-event-here"
check "createInvite"                             201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/invites" -d '{"label":"Smoke","maxUses":5}'
check "listInvites"                              200 "${AUTH[@]}" "$API/events/$SLUG/invites"
check "listRsvps"                                200 "${AUTH[@]}" "$API/events/$SLUG/rsvps"
contains "listRsvps carries the summary"         "$(body "${AUTH[@]}" "$API/events/$SLUG/rsvps")" '"headcount"'
check "updateRsvp rejects a bad status"          422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$API/events/$SLUG/rsvps/nope" -d '{"status":"perhaps"}'

echo
echo "== lifecycle =="
check "setEventStatus draft -> published"        200 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/status" -d '{"status":"published"}'
BADT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/status" -d '{"status":"polling"}')
check "published -> polling is refused"          409 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/status" -d '{"status":"polling"}'
contains "the refusal names the current status"  "$BADT" '"invalid_transition"'
contains "...and puts it in details.from"        "$BADT" '"from":"published"'

echo
echo "== timeline, potluck, media, chat =="
check "addTimelineItem"                          201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/timeline" -d '{"title":"Apéro","type":"meal"}'
check "listTimeline"                             200 "${AUTH[@]}" "$API/events/$SLUG/timeline"
check "addPotluckItem"                           201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/contributions" -d '{"title":"Dessert","category":"food"}'
check "listPotluck"                              200 "${AUTH[@]}" "$API/events/$SLUG/contributions"
check "listMedia"                                200 "${AUTH[@]}" "$API/events/$SLUG/media"
CHAT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/chat" -d '{"body":"Doors at six."}')
contains "postEventChatMessage badges the host"  "$CHAT" '"isHost":true'
contains "...as the zäme planner, not an Enterprise-supplied name" "$CHAT" '"authorName":"'
check "readEventChat"                            200 "${AUTH[@]}" "$API/events/$SLUG/chat"
check "readEventChat?afterId"                    200 "${AUTH[@]}" "$API/events/$SLUG/chat?afterId=nothing"
check "inviteCoOrganizer"                        201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SLUG/planner-invites" -d '{"role":"co_planner"}'

echo
echo "== the trip budget (integer cents, no floats) =="
TRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke trip $SUFFIX\",\"type\":\"trip\"}")
TSLUG=$(printf '%s' "$TRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
EXP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSLUG/expenses" \
  -d '{"title":"Airbnb","amountCents":42000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}')
contains "addTripExpense materialises even shares" "$EXP" '"amountCents":14000'
check "getTripBudget"                            200 "${AUTH[@]}" "$API/events/$TSLUG/budget"
contains "the budget suggests a settlement plan" "$(body "${AUTH[@]}" "$API/events/$TSLUG/budget")" '"settlements"'
check "shares that exceed the total are refused" 422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSLUG/expenses" \
  -d '{"title":"Bad","amountCents":100,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":500}]}'

echo
echo "== the series (the movie-night path) =="
SER=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke cinema $SUFFIX\",\"type\":\"series\",\"cadence\":\"every second Friday\"}")
SSLUG=$(printf '%s' "$SER" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
check "addSeriesMember"                          200 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SSLUG/series/members" -d '{"name":"Ana","email":"ana@example.com"}'
check "addSeriesMember is idempotent by email"   200 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SSLUG/series/members" -d '{"name":"Ana","email":"ANA@example.com"}'
check "listSeriesMembers"                        200 "${AUTH[@]}" "$API/events/$SSLUG/series/members"
SHOW=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SSLUG/series/showings" -d '{"title":"Movie night: Heat (1995)","startsAt":"2027-03-05T20:00:00+01:00"}')
contains "scheduleSeriesShowing publishes it"    "$SHOW" '"status":"published"'
contains "...and returns a Showing"              "$SHOW" '"signUpCount"'
check "listSeriesShowings"                       200 "${AUTH[@]}" "$API/events/$SSLUG/series/showings"
check "series ops refuse a non-series event"     422 "${AUTH[@]}" "$API/events/$SLUG/series/members"

echo
echo "== the two-stage party =="
PARTY=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/parties" \
  -d "{\"title\":\"Smoke party $SUFFIX\",\"coreInvites\":[{\"name\":\"Ana\",\"email\":\"ana@example.com\"},{\"name\":\"Sam\"}],\"dateOptions\":[{\"startsAt\":\"2027-04-10T20:00:00+02:00\"},{\"startsAt\":\"2027-04-17T20:00:00+02:00\"}]}")
PSLUG=$(printf '%s' "$PARTY" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
contains "createPartyPlan opens the poll"        "$PARTY" '"status":"polling"'
contains "...and mints core invites"             "$PARTY" '"tier":"core"'
check "proposeDateOption"                        201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/poll/options" -d '{"startsAt":"2027-04-24T20:00:00+02:00","note":"backup"}'
check "listDatePoll"                             200 "${AUTH[@]}" "$API/events/$PSLUG/poll"
check "openUpParty before the date is locked"    409 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/open-up" -d '{}'
OPT=$(body "${AUTH[@]}" "$API/events/$PSLUG/poll" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
check "lockEventDate"                            200 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/poll/lock" -d "{\"optionId\":\"$OPT\"}"
OPEN=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/open-up" -d '{"label":"Open invitation"}')
contains "openUpParty assembles the share link"  "$OPEN" '"url"'

echo
echo "== the hot path: getEventsSnapshot =="
HDR=$(mktemp)
SNAP=$(curl -s -D "$HDR" "${AUTH[@]}" "$API/snapshot")
contains "the summary is a complete sentence"    "$SNAP" '"summary":"The user has'
contains "carries the Bridge stats"              "$SNAP" '"label":"UPCOMING"'
contains "carries the attention COUNT only"      "$SNAP" '"needsAttentionCount"'
contains "sets the documented Cache-Control"     "$(tr -d '\r' < "$HDR")" 'private, max-age=60, stale-while-revalidate=600'
ETAG=$(tr -d '\r' < "$HDR" | sed -n 's/^[Ee][Tt]ag: //p')
check "revalidates to 304 with If-None-Match"    304 "${AUTH[@]}" -H "If-None-Match: $ETAG" "$API/snapshot"
check "honours upcomingLimit"                    200 "${AUTH[@]}" "$API/snapshot?upcomingLimit=1"
# The contract declares NO 5xx for this operation. Whatever else is wrong, an
# authenticated caller gets a usable snapshot; an unauthenticated one still does
# not. Run this against a stopped Postgres to see `degraded: true` instead.
check "an unauthenticated snapshot is still refused" 401 "$API/snapshot"
rm -f "$HDR"

echo
echo "== the check-in facts: getEventsAttention =="
check "getEventsAttention"                       200 "${AUTH[@]}" "$API/attention"
ATT=$(body "${AUTH[@]}" "$API/attention?horizonDays=365&limit=1")
contains "findings are DeptFinding-shaped"       "$ATT" '"urgency"'
contains "...with the raw facts alongside"       "$ATT" '"daysAway"'
contains "...and a deep link into the planner"   "$ATT" '"url":"/host/'

echo
echo "== the concert projection =="
SRC="smoke_concert_$SUFFIX"
PUB=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/publish" \
  -d "{\"sourceId\":\"$SRC\",\"title\":\"Smoke symphony $SUFFIX\",\"startsAt\":\"2027-05-14T19:30:00+02:00\"}")
contains "publishConcert mints the announcement" "$PUB" '"created":true'
REPUB=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/publish" \
  -d "{\"sourceId\":\"$SRC\",\"eventId\":\"deliberately-stale\",\"title\":\"Smoke symphony $SUFFIX\",\"startsAt\":\"2027-05-14T19:30:00+02:00\"}")
contains "a stale eventId hint still patches"    "$REPUB" '"created":false'
check "publishConcert needs a start time"        422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/publish" -d "{\"sourceId\":\"$SRC\",\"title\":\"No date\"}"
DOWN=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/unpublish" -d "{\"sourceId\":\"$SRC\"}")
contains "unpublishConcert takes it down"        "$DOWN" '"alreadyDown":false'
AGAIN=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/unpublish" -d "{\"sourceId\":\"$SRC\"}")
contains "...and is idempotent"                  "$AGAIN" '"alreadyDown":true'
check "unpublishing something never announced"   404 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/unpublish" -d '{"sourceId":"never_announced_at_all"}'

echo
echo "== the content-addressed poster =="
if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
  IMG=$(mktemp); printf '\x89PNG\r\n\x1a\n' > "$IMG"; head -c 512 /dev/urandom >> "$IMG"
  SHA=$(sha256sum "$IMG" | cut -d' ' -f1)
  WRONG_SHA=$(printf 'not these bytes' | sha256sum | cut -d' ' -f1)
  check "headPoster before upload"               404 -I "${AUTH[@]}" "$API/media/posters/$SHA"
  check "a digest that is not hex"               422 "${AUTH[@]}" -X PUT -H 'content-type: image/png' --data-binary "@$IMG" "$API/media/posters/NOTHEX"
  check "an unsupported image type"              415 "${AUTH[@]}" -X PUT -H 'content-type: image/gif' --data-binary "@$IMG" "$API/media/posters/$SHA"
  BAD=$(body "${AUTH[@]}" -X PUT -H 'content-type: image/png' --data-binary "@$IMG" "$API/media/posters/$WRONG_SHA")
  contains "the digest is verified SERVER-side"  "$BAD" '"The bytes do not hash to the sha256 in the path."'
  UP=$(body "${AUTH[@]}" -X PUT -H 'content-type: image/png' --data-binary "@$IMG" "$API/media/posters/$SHA")
  contains "uploadPoster stores the bytes"       "$UP" '"alreadyPresent":false'
  contains "...and returns an absolute URL"      "$UP" '"posterUrl":"http'
  check "headPoster after upload short-circuits" 204 -I "${AUTH[@]}" "$API/media/posters/$SHA"
  UP2=$(body "${AUTH[@]}" -X PUT -H 'content-type: image/png' --data-binary "@$IMG" "$API/media/posters/$SHA")
  contains "re-uploading identical bytes is a no-op" "$UP2" '"alreadyPresent":true'
  check "headPoster still needs the token"       401 -I "$API/media/posters/$SHA"

  # The gate: the bytes are inert until a public, published event points at them.
  PURL=$(printf '%s' "$UP" | sed -n 's/.*"posterUrl":"\([^"]*\)".*/\1/p')
  PSRC="smoke_poster_$SUFFIX"
  check "the poster does not resolve yet"        404 "$PURL"
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/publish" \
    -d "{\"sourceId\":\"$PSRC\",\"title\":\"Poster smoke $SUFFIX\",\"startsAt\":\"2027-06-01T19:30:00+02:00\",\"posterUrl\":\"$PURL\"}" > /dev/null
  check "it resolves once a public event cites it" 200 "$PURL"
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/concerts/unpublish" -d "{\"sourceId\":\"$PSRC\"}" > /dev/null
  check "and stops the moment that is taken down"  404 "$PURL"
  rm -f "$IMG"
else
  echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run these"
fi

echo
echo "-------------------------------------------------------------------"
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
