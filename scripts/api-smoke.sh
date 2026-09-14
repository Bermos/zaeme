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
#
# Two session cookies are optional too, and unlock the human-surface halves of
# the credential boundary — the parts no service token can prove:
#
#   ZAEME_TEST_SESSION_COOKIE   the INSTANCE OWNER's magic-link session
#   ZAEME_TEST_GUEST_COOKIE     any other account's session (a co-planner, say)
#
# `node scripts/ci-smoke-setup.mjs sign-in` does the whole dance for both
# accounts (it is what CI runs). By hand, per account:
#
#   # The Origin header is REQUIRED — better-auth's CSRF middleware answers
#   # 403 MISSING_OR_NULL_ORIGIN without it, and curl does not send one.
#   curl -s -X POST "$BASE/api/auth/sign-in/magic-link" \
#     -H 'content-type: application/json' -H "Origin: $BASE" \
#     -d '{"email":"owner@example.com","name":"Owner","callbackURL":"/host"}'
#   # Match the row by the email inside `value`, NOT by "the newest row": two
#   # sign-ins in a row are two unconsumed tokens, and newest-wins picks the
#   # wrong one exactly when you are setting up both cookies.
#   TOKEN=$(psql "$DATABASE_URL" -tAc "select identifier from zaeme_verification
#     where value like '%\"email\":\"owner@example.com\"%' and expires_at > now()
#     order by created_at desc limit 1")
#   curl -s -c owner.jar "$BASE/api/auth/magic-link/verify?token=$TOKEN&callbackURL=/host"
#   ZAEME_TEST_SESSION_COOKIE="better-auth.session_token=$(awk '/session_token/ {print $7}' owner.jar)"
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

# `equals <name> <got> <want>` — exact, for assertions where `contains` would
# pass on the wrong answer (an ORDER is the obvious one: every permutation of a
# list contains the same items).
equals() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1)); printf '  ok   %-58s\n' "$name"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL %-58s want [%s] got [%s]\n' "$name" "$want" "$got"
  fi
}

# `audit_await <url> <needle>` — the audit row is written from the response's
# `finish` hook, AFTER the body is on the wire, so a read issued straight
# afterwards can legitimately beat it. Poll briefly rather than sleep blindly,
# and return whatever the last read said so a failure still prints something.
#
# ⚠️ THE NEEDLE MUST BE SOMETHING ONLY AN `entries` ROW CAN CARRY.
# `GET /api/admin/audit` answers `{entries, summary}` and `summariseAudit` is
# UNFILTERED: `summary.bySurface` always contains `{"surface":"me",…}` and
# `summary.byActor` always contains `{"actorKind":"participant",…}` however
# narrow the query string is — a filter matching nothing at all still returns
# them beside `entries: []`. A needle drawn from either satisfies the FIRST
# read, so the poll never polls and the assertion that follows never fails.
# Use `"path":"…"` or `"actorLabel":"…"`, which appear in no summary.
audit_await() {
  local url="$1" needle="$2" out=''
  local i=0
  while [ "$i" -lt 20 ]; do
    out=$(body -H "Cookie: $ZAEME_TEST_SESSION_COOKIE" "$url")
    case "$out" in *"$needle"*) printf '%s' "$out"; return 0 ;; esac
    sleep 0.25
    i=$((i + 1))
  done
  printf '%s' "$out"
}

# The three fields of an itinerary, in the order the API returned them. No jq:
# this script runs wherever curl and sed do.
tl_titles() { printf '%s' "$1" | grep -o '"title":"[^"]*"' | sed 's/^"title":"//;s/"$//' | tr '\n' ' ' | sed 's/ $//'; }
tl_orders() { printf '%s' "$1" | grep -o '"sortOrder":[0-9-]*' | sed 's/^"sortOrder"://' | tr '\n' ' ' | sed 's/ $//'; }
tl_ids()    { printf '%s' "$1" | grep -o '"id":"[^"]*"' | sed 's/^"id":"//;s/"$//' | tr '\n' ' ' | sed 's/ $//'; }

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
echo "== the boundary: /api/admin is the owner's, and nobody else's =="
# Owner-only, and NOT a fourth credential — the host session plus one question
# (`server/utils/admin.ts`). The three ways in that must all fail:
check "no credential at all"                     401 "$BASE/api/admin/me"
check "a service token is not an admin session"  401 "${AUTH[@]}" "$BASE/api/admin/overview"
check "...not even on a write"                   401 "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/audit/prune" -d '{"olderThanDays":1}'
check "an invite token is not an admin session"  401 -H "Authorization: Bearer $TOKEN" "$BASE/api/admin/invites"

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  OWNER_COOKIE=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  check "the owner reaches the admin surface"    200 "${OWNER_COOKIE[@]}" "$BASE/api/admin/me"
  check "...and its cross-event reads"           200 "${OWNER_COOKIE[@]}" "$BASE/api/admin/overview"
  check "...and the instance administration"     200 "${OWNER_COOKIE[@]}" "$BASE/api/admin/accounts"
  contains "the audit records who did what"      "$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/audit?limit=5")" '"actorKind"'
  contains "the Enterprise token is a fingerprint, never itself" \
    "$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/integration")" '"fingerprint"'
  INTEG=$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/integration")
  case "$INTEG" in
    *"$TOKEN"*) FAIL=$((FAIL + 1)); printf '  FAIL %-58s the page leaked the service token\n' "the token itself never appears" ;;
    *) PASS=$((PASS + 1)); printf '  ok   %-58s\n' "the token itself never appears" ;;
  esac
  check "the owner is still refused on /api/v1"  401 "${OWNER_COOKIE[@]}" "$API/events"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  GUEST_COOKIE=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")
  # 403, not 401: this account is signed in and real — it is simply not the
  # owner. A planner plans events; administering the instance is not planning.
  check "another account's session is valid (control)" 200 "${GUEST_COOKIE[@]}" "$BASE/api/host/events"
  check "...but it is not the owner"             403 "${GUEST_COOKIE[@]}" "$BASE/api/admin/me"
  check "...on the reads"                        403 "${GUEST_COOKIE[@]}" "$BASE/api/admin/accounts"
  check "...and on the writes"                   403 "${GUEST_COOKIE[@]}" -X DELETE "$BASE/api/admin/accounts/whoever"
else
  echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a NON-owner session to run these"
fi

echo
echo "== the base currency is the OWNER's setting, and it is a VALUE (#25, D6) =="
# This block runs BEFORE any expense in the suite, on purpose. The change is
# refused once an expense is recorded against a different base, so a settings
# check placed after the fixtures can only ever prove the refusal — and a
# `setInstanceBaseCurrency` that discarded its input and wrote the default
# would pass every other check in this file.
#
# A re-run against a database the last run left behind would be blocked by its
# own fixtures, so the block CLEARS the instance of expenses it can reach first.
# On a fresh database (which is what CI hands it) that loop does nothing.
for CLEAN_SLUG in $(body "${AUTH[@]}" "$API/events" | grep -o '"slug":"[^"]*"' | sed 's/^"slug":"//;s/"$//'); do
  for CLEAN_ID in $(body "${AUTH[@]}" "$API/events/$CLEAN_SLUG/budget" | grep -o '"id":"[^"]*"' | sed 's/^"id":"//;s/"$//'); do
    curl -s -o /dev/null "${AUTH[@]}" -X DELETE "$API/events/$CLEAN_SLUG/expenses/$CLEAN_ID"
  done
done

check "the instance settings need a session"     401 "$BASE/api/admin/settings"
check "...and a service token is not one"        401 "${AUTH[@]}" "$BASE/api/admin/settings"

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  SET_OWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  check "the owner reads them"                   200 "${SET_OWNER[@]}" "$BASE/api/admin/settings"
  check "...and writes them"                     200 "${SET_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"EUR"}'
  contains "...to the VALUE that was asked for"         "$(body "${SET_OWNER[@]}" "$BASE/api/admin/settings")" '"baseCurrency":"EUR"'
  check "...and back again"                      200 "${SET_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"CHF"}'
  contains "...which the read reflects too"             "$(body "${SET_OWNER[@]}" "$BASE/api/admin/settings")" '"baseCurrency":"CHF"'
  contains "...and records that somebody chose it"      "$(body "${SET_OWNER[@]}" "$BASE/api/admin/settings")" '"configured":true'
  check "a code that is not three letters"       400 "${SET_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"CH"}'
  # The rate the expense form prefills, and the ONE place in this suite that
  # makes a real, successful call to frankfurter. Every other expense here pins
  # `fxRate` by hand, so without this the whole FX client could be broken — a
  # moved host, a renamed field — and the only symptom would be foreign
  # expenses quietly demanding a manual rate, which no other check can see.
  contains "a live rate actually comes back"            "$(body "${SET_OWNER[@]}" "$BASE/api/me/fx/rate?from=EUR")" '"rate":"'
  contains "...dated by the source that published it"   "$(body "${SET_OWNER[@]}" "$BASE/api/me/fx/rate?from=EUR")" '"asOf":"20'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  SET_GUEST=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")
  check "another account cannot read the settings" 403 "${SET_GUEST[@]}" "$BASE/api/admin/settings"
  check "...nor change what everyone settles in"   403 "${SET_GUEST[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"EUR"}'
else
  echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a NON-owner session to run these"
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
echo "== re-ordering an itinerary, executed (Bermos/zaeme#8) =="
# The ONLY evidence `applyTimelineItemMove` computes the right thing. Every
# static check it has passes just as happily when the statement does the
# opposite: deleting the transposition, pinning `delta` to +1, or dropping the
# `event_id` scoping so it renumbers every itinerary on the INSTANCE into one
# global sequence are all invisible to vitest and eslint. So the move is run,
# and the resulting ORDER and NUMBERING are asserted — the global-renumber
# mutation is what the exact "0 10 20" below exists to catch.
#
# The tie is minted through the machine API rather than faked, because that is
# how a real one arrives: `addTimelineItem` takes an explicit `sortOrder`, so
# Enterprise can put two items on one number by itself.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  OWNER_COOKIE=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  ORD=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke order $SUFFIX\",\"type\":\"trip\"}")
  OSLUG=$(printf '%s' "$ORD" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  echo "  itinerary: $OSLUG"
  check "an itinerary item"                        201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$OSLUG/timeline" -d '{"title":"Alpha","type":"transport","sortOrder":10}'
  check "...a second"                              201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$OSLUG/timeline" -d '{"title":"Bravo","type":"meal","sortOrder":20}'
  check "...and a third ON THE SAME NUMBER"        201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$OSLUG/timeline" -d '{"title":"Charlie","type":"meal","sortOrder":20}'

  TL=$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/events/$OSLUG/timeline")
  equals "the machine API can mint a tie by itself" "$(tl_orders "$TL")" "10 20 20"
  # Which of the tied pair sorts first is decided by created_at and then by id,
  # so it is read rather than assumed; everything after this is relative to it.
  A=$(tl_titles "$TL" | cut -d' ' -f1)
  B=$(tl_titles "$TL" | cut -d' ' -f2)
  C=$(tl_titles "$TL" | cut -d' ' -f3)
  LAST=$(tl_ids "$TL" | awk '{print $NF}')

  check "moveTimelineItem up (admin)"              200 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/events/$OSLUG/timeline/$LAST/move" -d '{"direction":"up"}'
  TL=$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/events/$OSLUG/timeline")
  equals "...transposes it with its neighbour"     "$(tl_titles "$TL")" "$A $C $B"
  equals "...and renumbers, so the tie is gone"    "$(tl_orders "$TL")" "0 10 20"

  check "moving it up again"                       200 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/events/$OSLUG/timeline/$LAST/move" -d '{"direction":"up"}'
  equals "...puts it first"                        "$(tl_titles "$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/events/$OSLUG/timeline")")" "$C $A $B"

  check "moving it up off the top is a no-op"      200 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/events/$OSLUG/timeline/$LAST/move" -d '{"direction":"up"}'
  TL=$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/events/$OSLUG/timeline")
  equals "...and really is one"                    "$(tl_titles "$TL")" "$C $A $B"
  equals "...with the numbering still total"       "$(tl_orders "$TL")" "0 10 20"

  check "an item that is not on this itinerary"    404 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/events/$OSLUG/timeline/no-such-item/move" -d '{"direction":"up"}'
  check "a direction that is not up or down"       400 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/admin/events/$OSLUG/timeline/$LAST/move" -d '{"direction":"sideways"}'

  # The same verb on the host surface, which is where a planner actually is.
  check "moveTimelineItem down (host)"             200 "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$OSLUG/timeline/$LAST/move" -d '{"direction":"down"}'
  equals "...moves it the other way"               "$(tl_titles "$(body "${OWNER_COOKIE[@]}" "$BASE/api/admin/events/$OSLUG/timeline")")" "$A $C $B"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

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
echo "== mixed currencies settle in ONE base (#25) =="
# The bug this section exists for: `currency` was stored, typed and rendered
# while `computeBalances` summed `amountCents` across every row whatever it
# said, so a EUR dinner on a CHF trip went in as EUR-cents-pretending-to-be-CHF.
# Every assertion here is therefore a VALUE, reconciled by hand, executed
# against a real Postgres — a test that greps the SQL would survive the bug.
#
#   chalet  CHF 300.00, three ways           → base 30000, shares 10000 x3
#   dinner  EUR 100.00 at 0.9412, three ways → base  9412, shares 3138/3137/3137
#   taxi    GBP  45.00 at 1.1,    three ways → base  4950, shares  1650 x3
#
#   A paid 30000, owes 14788 → +15212      B paid 4950, owes 14787 → -9837
#   C paid  9412, owes 14787 →  -5375      total 44362
FXTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke fx $SUFFIX\",\"type\":\"trip\"}")
FSLUG=$(printf '%s' "$FXTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
SPLIT3='[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]'

CHALET=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Chalet\",\"amountCents\":30000,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT3}")
contains "an expense in the base currency needs no rate" "$CHALET" '"fxRate":"1"'
contains "...and converts one for one"                   "$CHALET" '"amountBaseCents":30000'
contains "...recording the base it was settled against"  "$CHALET" '"baseCurrency":"CHF"'

DINNER=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Dinner\",\"amountCents\":10000,\"currency\":\"EUR\",\"fxRate\":\"0.9412\",\"paidByName\":\"C\",\"paidByEmail\":\"c@e.com\",\"participants\":$SPLIT3}")
contains "a foreign expense keeps what was SPENT"        "$DINNER" '"amountCents":10000,"currency":"EUR"'
contains "...freezes the rate it was recorded at"        "$DINNER" '"fxRate":"0.9412"'
contains "...and is converted once, at that rate"        "$DINNER" '"amountBaseCents":9412'
contains "...with the shares apportioned in base too"    "$DINNER" '"amountCents":3334,"amountBaseCents":3138'
contains "...so the base shares sum to it exactly"       "$DINNER" '"amountCents":3333,"amountBaseCents":3137'

TAXI=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Taxi\",\"amountCents\":4500,\"currency\":\"GBP\",\"fxRate\":\"1.1\",\"paidByName\":\"B\",\"paidByEmail\":\"b@e.com\",\"participants\":$SPLIT3}")
contains "a third currency converts on its own rate"     "$TAXI" '"amountCents":4500,"currency":"GBP"'
contains "...to its own base figure"                     "$TAXI" '"amountBaseCents":4950'

FXB=$(body "${AUTH[@]}" "$API/events/$FSLUG/budget")
contains "the budget is labelled with the INSTANCE base" "$FXB" '"currency":"CHF","totalCents":44362'
contains "A is owed the difference, in base cents"       "$FXB" '"a@e.com","paidCents":30000,"owedCents":14788,"netCents":15212'
contains "B is down what they fronted less their share"  "$FXB" '"b@e.com","paidCents":4950,"owedCents":14787,"netCents":-9837'
contains "C likewise, on a different currency again"     "$FXB" '"c@e.com","paidCents":9412,"owedCents":14787,"netCents":-5375'
contains "the plan clears the smaller debt"              "$FXB" '"toEmail":"a@e.com","amountCents":5375'
contains "...and the larger one"                         "$FXB" '"toEmail":"a@e.com","amountCents":9837'

DINNER_ID=$(printf '%s' "$DINNER" | grep -o '"id":"[^"]*"' | head -1 | sed 's/^"id":"//;s/"$//')
check "removing the foreign expense"             200 "${AUTH[@]}" -X DELETE "$API/events/$FSLUG/expenses/$DINNER_ID"
FXB2=$(body "${AUTH[@]}" "$API/events/$FSLUG/budget")
contains "...takes exactly its base cents with it"       "$FXB2" '"currency":"CHF","totalCents":34950'
contains "...leaving the balances still reconciled"      "$FXB2" '"a@e.com","paidCents":30000,"owedCents":11650,"netCents":18350'
contains "...with no residue from the conversion"        "$FXB2" '"b@e.com","paidCents":4950,"owedCents":11650,"netCents":-6700'
contains "...for anybody"                                "$FXB2" '"c@e.com","paidCents":0,"owedCents":11650,"netCents":-11650'

# A currency nobody publishes a rate for: the write is refused and NAMES the way
# through, rather than recording money at a rate nobody chose.
NORATE="{\"title\":\"Bazaar\",\"amountCents\":1000,\"currency\":\"XXX\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}"
check "an unquotable currency is refused"        422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" -d "$NORATE"
contains "...and asks for the rate by hand"              "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" -d "$NORATE")" 'Enter the rate yourself'
BYHAND=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Bazaar\",\"amountCents\":1000,\"currency\":\"XXX\",\"fxRate\":\"2\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}")
contains "...which is then recorded at that rate"        "$BYHAND" '"amountBaseCents":2000'

# A rate that would not survive the column it lands in. Both were unhandled
# Postgres errors escaping as 500s before #57 review: `integer out of range` on
# the converted amount, `numeric field overflow` on the rate itself.
check "a rate with too many digits"              422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Huge\",\"amountCents\":1000,\"currency\":\"XXX\",\"fxRate\":\"9999999999\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}"
check "...and one with too many decimals"        422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Precise\",\"amountCents\":1000,\"currency\":\"XXX\",\"fxRate\":\"1.123456789012\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}"
check "...and an amount that overruns the column" 422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Overflow\",\"amountCents\":1000,\"currency\":\"XXX\",\"fxRate\":\"999999999\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}"

# An expense with NO fxRate, in a currency the ECB publishes: the only write in
# this suite that depends on the outbound fetch working. `equals` rather than
# `contains`, because the answer that has to fail is "1" — a broken client that
# fell back to the identity would satisfy any substring check for a rate.
LIVE=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$FSLUG/expenses" \
  -d "{\"title\":\"Gelato\",\"amountCents\":12000,\"currency\":\"EUR\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\"}]}")
LIVERATE=$(printf '%s' "$LIVE" | sed -n 's/.*"fxRate":"\([^"]*\)".*/\1/p')
equals "an expense with no rate fetches a live one" "$([ -n "$LIVERATE" ] && [ "$LIVERATE" != "1" ] && echo fetched || echo "not-fetched:${LIVERATE:-none}")" "fetched"

# A budget whose FIRST expense is foreign. Without this trip, reverting
# `loadBudget`'s `currency: baseCurrency` to the original
# `expenses[0]?.currency` leaves every check in this file green: every other
# budget here happens to open with an expense already in the base.
ONLYEUR=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke foreign-first $SUFFIX\",\"type\":\"trip\"}")
OSLUG2=$(printf '%s' "$ONLYEUR" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
FIRST=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$OSLUG2/expenses" \
  -d "{\"title\":\"Dinner\",\"amountCents\":10000,\"currency\":\"EUR\",\"fxRate\":\"0.9412\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT3}")
contains "the only expense on this trip is foreign"      "$FIRST" '"amountCents":10000,"currency":"EUR"'
FIRSTB=$(body "${AUTH[@]}" "$API/events/$OSLUG2/budget")
contains "...and the budget is STILL labelled in base"   "$FIRSTB" '"currency":"CHF"'
contains "...totalling the converted cents, not the spent ones" "$FIRSTB" '"totalCents":9412'

echo
echo "== ...and is FROZEN once expenses are converted into it (#25) =="
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  LOCK_OWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  # The rule that keeps every balance summable: expenses freeze the base they
  # were converted into, so the instance base cannot drift away from them. By
  # now the fixtures above have recorded some, so the change that succeeded at
  # the top of this run is refused here — which is the whole of the lock.
  check "changing it under recorded expenses"    409 "${LOCK_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"EUR"}'
  contains "...and says which expenses hold it"          "$(body "${LOCK_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"EUR"}')" 'already recorded against a different base currency'
  contains "...and where to go and remove them"         "$(body "${LOCK_OWNER[@]}" "$BASE/api/admin/settings")" '"hold":{"bases":['
  contains "...naming the trips by slug"                "$(body "${LOCK_OWNER[@]}" "$BASE/api/admin/settings")" "\"slug\":\"$FSLUG\""
  contains "...and the base is still what it was"       "$(body "${LOCK_OWNER[@]}" "$BASE/api/admin/settings")" '"baseCurrency":"CHF"'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

echo
echo "== the boundary: money is written by an ACCOUNT, read by the link (#48) =="
# Reading the budget is still the invite capability URL's; writing an expense
# moved onto a session plus an RSVP-or-planner row. These are the halves no
# structural test can prove — that the routes actually answer this way.
# An invite link only resolves on a live event (a draft 403s), so publish first.
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSLUG/status" -d '{"status":"published"}' > /dev/null
ITOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSLUG/invites" -d '{"label":"Budget smoke"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
MEEXP="$BASE/api/me/events/$TSLUG/expenses"
NEW='{"title":"Coffee","amountCents":900,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"}]}'

check "the budget still reads over the invite link" 200 "$BASE/api/invites/$ITOK/budget"
check "the invite link no longer WRITES an expense" 404 "${JSON[@]}" -X POST "$BASE/api/invites/$ITOK/expenses" -d "$NEW"
check "...not even holding a valid token"           404 "${JSON[@]}" -X DELETE "$BASE/api/invites/$ITOK/expenses/whatever"
check "an anonymous expense write is refused"       401 "${JSON[@]}" -X POST "$MEEXP" -d "$NEW"
check "a service token is not an account either"    401 "${AUTH[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$NEW"

if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  # Signed in and real, but with no RSVP and no planner row on this trip —
  # 403, not 401: the credential is fine, the standing is not.
  check "an account that is not on the event"       403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" -X POST "$MEEXP" -d "$NEW"
else
  echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a NON-participant session to run this"
fi

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  PLANNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  # The owner planned this trip (the machine API acts as them), so they pass
  # `assertParticipant` as a planner and the write goes through.
  PAID=$(body "${PLANNER[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$NEW")
  contains "a planner's account may write"          "$PAID" '"expenses"'
  contains "...and the row records WHO added it"    "$PAID" '"addedByName"'

  # The event LIFECYCLE check used to come free with `resolveInviteToken`.
  # Moving the write off the token dropped it, and an expense recorded happily
  # against a cancelled trip; `assertEventOpenToGuests` is that rule, shared.
  DRAFT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke draft trip $SUFFIX\",\"type\":\"trip\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  check "a DRAFT event takes no expense"           403 "${PLANNER[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$DRAFT/expenses" -d "$NEW"
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$DRAFT/status" -d '{"status":"published"}' > /dev/null
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$DRAFT/status" -d '{"status":"cancelled"}' > /dev/null
  check "a CANCELLED event takes no expense"       403 "${PLANNER[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$DRAFT/expenses" -d "$NEW"
  # …but a finished trip must still settle up. This LEAVES $TSLUG completed, and
  # has to: `STATUS_TRANSITIONS.completed` is `[]` (`server/domain/events-data.ts`),
  # so `completed` is terminal and there is no legal way back to `published`. A
  # restore here would 409 into /dev/null and read as if it had worked — so any
  # check appended below must mint its own event rather than assume this one.
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSLUG/status" -d '{"status":"completed"}' > /dev/null
  check "a COMPLETED event still settles up"       200 "${PLANNER[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$NEW"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

echo
echo "== the audit tells a participant from a planner (Bermos/zaeme#51) =="
# The ONE thing that proves #51, and no unit test can: a real participant write
# on /api/me, executed, and then the kind the audit actually RECORDED for it.
# Every structural check passes just as happily with the old
# `owner-or-planner` line in place — the label is computed at the edge and read
# back by a query, so the only honest assertion runs both halves.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ] && [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  OWNER_COOKIE=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  GUEST=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")

  # A trip of its own: $TSLUG above is left `completed` and cannot come back
  # (`STATUS_TRANSITIONS.completed` is `[]`), and an invite token only resolves
  # on a live event.
  ATRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke audit trip $SUFFIX\",\"type\":\"trip\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ATRIP/status" -d '{"status":"published"}' > /dev/null
  ATOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ATRIP/invites" -d '{"label":"Audit smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

  # The second account's OWN address, asked of better-auth rather than guessed:
  # a participant is an RSVP whose guestEmail is the account's email, so the
  # whole check turns on getting that string right.
  GEMAIL=$(body "${GUEST[@]}" "$BASE/api/auth/get-session" | grep -o '"email":"[^"]*"' | head -1 | sed 's/^"email":"//;s/"$//')
  body "${JSON[@]}" -X POST "$BASE/api/invites/$ATOK/rsvp" \
    -d "{\"status\":\"yes\",\"guestName\":\"CI Guest\",\"guestEmail\":\"$GEMAIL\"}" > /dev/null

  # Each read below is filtered by `actorKind` AND `surface` AND `eventSlug`, so
  # any row that comes back in `entries` is BY CONSTRUCTION of the kind asked
  # for — which is what lets the assertions match on identity (`actorLabel`,
  # `path`) and still prove the kind. They must match on identity: see the
  # warning on `audit_await`, the summary beside `entries` names every kind and
  # every surface unconditionally.
  OEMAIL=$(body "${OWNER_COOKIE[@]}" "$BASE/api/auth/get-session" | grep -o '"email":"[^"]*"' | head -1 | sed 's/^"email":"//;s/"$//')

  # No planner row on this trip, an RSVP and nothing else — which is exactly the
  # caller #48 created and #51 was mislabelling.
  check "a participant with an RSVP may write an expense" 200 "${GUEST[@]}" "${JSON[@]}" \
    -X POST "$BASE/api/me/events/$ATRIP/expenses" -d "$NEW"
  APART=$(audit_await "$BASE/api/admin/audit?actorKind=participant&surface=me&eventSlug=$ATRIP&limit=10" \
    "\"path\":\"/api/me/events/$ATRIP/expenses\"")
  contains "...and the audit files it as a participant" "$APART" "\"path\":\"/api/me/events/$ATRIP/expenses\""
  contains "...against the account that wrote it"       "$APART" "\"actorLabel\":\"$GEMAIL\""

  # …and a NON-owner who really does plan the event is still a planner on the
  # same surface. The second account plans its own trip, which is the only way
  # to come by a planner row without being the instance owner.
  GTRIP=$(body "${GUEST[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events" \
    -d "{\"title\":\"Smoke guest trip $SUFFIX\",\"type\":\"trip\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${GUEST[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$GTRIP/status" -d '{"status":"published"}' > /dev/null
  check "a planner who is not the owner may write there too" 200 "${GUEST[@]}" "${JSON[@]}" \
    -X POST "$BASE/api/me/events/$GTRIP/expenses" -d "$NEW"
  APLAN=$(audit_await "$BASE/api/admin/audit?actorKind=planner&surface=me&eventSlug=$GTRIP&limit=10" \
    "\"actorLabel\":\"$GEMAIL\"")
  contains "...and the audit still calls them a planner" "$APLAN" "\"actorLabel\":\"$GEMAIL\""

  # …while the same surface, written by the instance owner, is still the owner's.
  # These three together are what make the per-request decision falsifiable:
  # labelling the whole of /api/me one way breaks the planner read and this one,
  # and resolving nobody breaks the participant read.
  body "${OWNER_COOKIE[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$ATRIP/expenses" -d "$NEW" > /dev/null
  AOWN=$(audit_await "$BASE/api/admin/audit?actorKind=owner&surface=me&eventSlug=$ATRIP&limit=10" \
    "\"actorLabel\":\"$OEMAIL\"")
  contains "...and the owner's own write is still the owner's" "$AOWN" "\"actorLabel\":\"$OEMAIL\""
else
  echo "  skip  set both ZAEME_TEST_SESSION_COOKIE and ZAEME_TEST_GUEST_COOKIE to run these"
fi

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
