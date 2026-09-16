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

# `excludes <name> <haystack> <needle>` — the NEGATIVE of `contains`, for the
# assertions that are about what a response must NOT carry. There is no way to
# write one with `contains`, and the hand-rolled `case` blocks that used to do
# this job (the service token on the integration page) are easy to get subtly
# wrong and never counted as checks.
excludes() {
  local name="$1" haystack="$2" needle="$3"
  case "$haystack" in
    *"$needle"*)
      FAIL=$((FAIL + 1)); printf '  FAIL %-58s leaked %s\n' "$name" "$needle"
      printf '       got: %.200s\n' "$haystack" ;;
    *) PASS=$((PASS + 1)); printf '  ok   %-58s\n' "$name" ;;
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

# THE LEDGER HELPERS (#61). The budget is double-entry now, and the one
# assertion worth more than all the others is that every entry's lines sum to
# zero. That is arithmetic over a JSON array, which sed cannot do honestly — so
# these four shell out to node, which every machine that can build this app
# already has.

# `ledger_imbalance <budget-json>` — the WORST absolute imbalance across every
# entry in a budget, in cents, counting an entry with no lines at all as broken.
# `0` is the only passing answer. Accepts a bare budget or a `{budget:…}` body,
# because /api/v1 answers the first and the human surfaces answer the second.
ledger_imbalance() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      // A budget, or the single expense a /api/v1 write answers with.
      const expenses = budget.expenses ?? (budget.lines ? [budget] : [])
      if (!expenses.length) return process.stdout.write("no-expenses")
      let worst = 0
      for (const e of expenses) {
        const lines = e.lines ?? []
        if (!lines.length) { worst = Math.max(worst, 1e9); continue }
        worst = Math.max(
          worst,
          Math.abs(lines.reduce((a, l) => a + l.amountCents, 0)),
          Math.abs(lines.reduce((a, l) => a + l.amountBaseCents, 0))
        )
      }
      process.stdout.write(String(worst))
    })'
}

# `plan_closes <budget-json>` — whether the settlement plan clears the budget
# EXACTLY: every member balance nets to zero across the ledger, and the plan
# hands over precisely what the creditors are owed, to the cent. `closed` is the
# only passing answer; anything else says what was wrong.
#
# A `contains` cannot do this — it is arithmetic over the whole payload, and the
# criterion it exists for (#59: "the plan sums to zero exactly even when
# conversion leaves a residual") is precisely the case where a per-figure needle
# would still match while the totals had drifted apart.
plan_closes() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const balances = budget.balances ?? []
      const plan = budget.settlements ?? []
      if (!balances.length) return process.stdout.write("no-balances")
      const nets = balances.reduce((a, x) => a + x.netCents, 0)
      if (nets !== 0) return process.stdout.write("balances-sum-" + nets)
      const owed = balances.reduce((a, x) => a + (x.netCents > 0 ? x.netCents : 0), 0)
      const moved = plan.reduce((a, p) => a + p.amountCents, 0)
      if (moved !== owed) return process.stdout.write("plan-" + moved + "-of-" + owed)
      process.stdout.write("closed")
    })'
}

# `entry_lines <body> <title>` — how many lines the named entry has.
entry_lines() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      process.stdout.write(e ? String((e.lines ?? []).length) : "no-such-entry")
    })' "$2"
}

# `entry_order <body> <title>` — the names on the named entry's shares, in the
# order the payload lists them. All the lines of an entry share one `created_at`
# (Postgres `now()` is transaction time) and cuid2 ids do not sort by age, so
# without an explicit `seq` this is whatever the planner felt like returning.
entry_order() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      if (!e) return process.stdout.write("no-such-entry")
      process.stdout.write((e.shares ?? []).map(sh => sh.name).join(" "))
    })' "$2"
}

# `expense_id <body> <title>` — the id of the named entry, from a budget or from
# the single expense a /api/v1 write answers with. `no-such-entry` and not an
# empty string, because an empty one turns `…/expenses/$ID` into `…/expenses/`,
# which 404s for a reason that has nothing to do with what is being tested.
expense_id() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      process.stdout.write(e?.id ?? "no-such-entry")
    })' "$2"
}

# `entry_shares <body> <title>` — the named entry's share amounts AS SPENT, in
# the order the payload lists them.
#
# A SPLIT ASSERTION HAS TO BE ABOUT THE VECTOR (#26, #27). `totalCents` is the
# expense amount whatever the shares are, and a `contains` on ONE figure passes
# on a split that put that figure on the wrong person — which is exactly the
# difference between re-splitting an expense the way it was split and
# re-splitting it evenly, for every mode where those two disagree.
entry_shares() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      if (!e) return process.stdout.write("no-such-entry")
      process.stdout.write((e.shares ?? []).map(sh => sh.amountCents).join(" "))
    })' "$2"
}

# `entry_weights <body> <title>` — the percentages or share counts ENTERED on
# the named entry, in the same order. `null` where there was none, spelled out,
# so "the weights were dropped" and "the entry is not there" cannot both read as
# an empty string.
entry_weights() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      if (!e) return process.stdout.write("no-such-entry")
      process.stdout.write((e.shares ?? []).map(sh => sh.weight === null ? "null" : sh.weight).join(" "))
    })' "$2"
}

# `account_id <body> <name>` — the id of the named account, from a budget or an
# `{accounts:…}` body.
account_id() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("") }
      const list = b.accounts ?? b.budget?.accounts ?? []
      const a = list.find(x => x.name === process.argv[1])
      process.stdout.write(a ? a.id : "")
    })' "$2"
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

# THE MAP HELPERS (#30). A trip's places and legs come back as one object with
# two arrays, and the questions worth asking of it are "which id is that place"
# and "what order are the legs in" — neither of which sed can answer honestly
# once a name contains a space. Same shape as the ledger helpers above: a
# one-line `node -e` over the body, and a SENTINEL rather than a plausible
# answer when it finds nothing, so a dead server cannot read as a clean bill of
# health.

# `place_id <body> <name>` — the id of the named place, or "" if there is none.
place_id() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const p = (b.places ?? []).find(x => x.name === process.argv[1])
      process.stdout.write(p ? p.id : "")
    })' "$2"
}

# `leg_route <body>` — "From>To" per leg, in the order the API returned them.
# A `?` is an endpoint whose place was deleted, which is a state this suite
# deliberately produces.
leg_route() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const legs = b.legs
      if (!Array.isArray(legs)) return process.stdout.write("no-legs")
      process.stdout.write(legs.map(l => `${l.fromPlaceName ?? "?"}>${l.toPlaceName ?? "?"}`).join(" "))
    })'
}

# `leg_id_by_route <body> <from> <to>` — the id of the leg joining those two
# places by name. "The last leg in the answer" would be wrong the moment the
# order stops being creation order, which is exactly what this block tests.
leg_id_by_route() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const l = (b.legs ?? []).find(x => x.fromPlaceName === process.argv[1] && x.toPlaceName === process.argv[2])
      process.stdout.write(l ? l.id : "no-such-leg")
    })' "$2" "$3"
}

# `leg_orders <body>` — the legs' sort_order values, in the same order.
leg_orders() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const legs = b.legs
      if (!Array.isArray(legs)) return process.stdout.write("no-legs")
      process.stdout.write(legs.map(l => l.sortOrder).join(" "))
    })'
}

# The three fields of an itinerary, in the order the API returned them. No jq:
# this script runs wherever curl and sed do.
tl_titles() { printf '%s' "$1" | grep -o '"title":"[^"]*"' | sed 's/^"title":"//;s/"$//' | tr '\n' ' ' | sed 's/ $//'; }
tl_orders() { printf '%s' "$1" | grep -o '"sortOrder":[0-9-]*' | sed 's/^"sortOrder"://' | tr '\n' ' ' | sed 's/ $//'; }
tl_ids()    { printf '%s' "$1" | grep -o '"id":"[^"]*"' | sed 's/^"id":"//;s/"$//' | tr '\n' ' ' | sed 's/ $//'; }

# `geocode_shape <body>` (#32) — "well-formed", or what is wrong with it.
#
# A GEOCODER IS SOMEBODY ELSE'S SERVER and this suite runs in CI, so no check
# here may depend on Nominatim answering: a `contains '"name":"Ponte'` would
# redden this branch on the afternoon OpenStreetMap is having a bad time, or
# whenever the runner's address is one Nominatim declines to serve. What CAN be
# asserted unconditionally is that the answer is one of the two shapes this
# feature promises, and that whichever one arrived is INTERNALLY HONEST:
#
#   * `unavailable` carries a reason and NO results — "search is unavailable,
#     type the name", never a silently empty list that reads as "no matches";
#   * `ok` carries no reason, and every result is a place this app could
#     actually store: a name, coordinates on the planet at the six decimals
#     `numeric(9, 6)` holds, and an OSM reference that is both or neither.
#
# So when the geocoder IS reachable this validates every result it sent, and
# when it is not it validates the degrade path — and a dead zäme reads as
# `unparseable` rather than as a clean bill of health.
geocode_shape() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      if (b.status !== "ok" && b.status !== "unavailable") return process.stdout.write("no-status")
      if (!Array.isArray(b.results)) return process.stdout.write("no-results-array")
      if (typeof b.attribution !== "string" || !b.attribution) return process.stdout.write("no-attribution")
      if (b.status === "unavailable") {
        if (!b.reason) return process.stdout.write("unavailable-without-a-reason")
        if (b.results.length) return process.stdout.write("unavailable-with-results")
        if (b.cached !== false) return process.stdout.write("unavailable-but-cached")
        return process.stdout.write("well-formed")
      }
      if (b.reason !== null) return process.stdout.write("ok-with-a-reason")
      for (const r of b.results) {
        if (typeof r.name !== "string" || !r.name.trim()) return process.stdout.write("result-with-no-name")
        if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return process.stdout.write("result-with-no-position")
        if (Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) return process.stdout.write("result-off-the-planet")
        for (const v of [r.lat, r.lng]) {
          const dp = String(v).split(".")[1]?.length ?? 0
          if (dp > 6) return process.stdout.write("result-finer-than-the-column")
        }
        if ((r.osmType === null) !== (r.osmId === null)) return process.stdout.write("result-with-half-an-osm-reference")
      }
      process.stdout.write("well-formed")
    })'
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
echo "== the default currency for new trips is the OWNER's setting, and it is a VALUE (#25 D6, #59) =="
# It has to be a VALUE and not a boolean: a `setInstanceBaseCurrency` that
# discarded its input and wrote the default would pass a `"configured":true`
# check and every other check in this file (#57 shipped exactly that).
#
# THERE USED TO BE A DESTRUCTIVE LOOP HERE, deleting every expense the service
# token could reach, because #25 refused this change while any expense disagreed
# with the requested base and a re-run would otherwise be blocked by its own
# fixtures. Currency belongs to the trip since #59, so there is nothing to
# unblock — and a suite that emptied the instance's budgets before looking at
# them was also the reason anything inspecting rows from a previous run had to
# come first in this file. It does not any more.

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
contains "the budget is labelled with the TRIP's currency" "$FXB" '"currency":"CHF","approximate":true,"totalCents":44362'
contains "A is owed the difference, in base cents"       "$FXB" '"a@e.com","paidCents":30000,"owedCents":14788,"netCents":15212'
contains "B is down what they fronted less their share"  "$FXB" '"b@e.com","paidCents":4950,"owedCents":14787,"netCents":-9837'
contains "C likewise, on a different currency again"     "$FXB" '"c@e.com","paidCents":9412,"owedCents":14787,"netCents":-5375'
contains "the plan clears the smaller debt"              "$FXB" '"toEmail":"a@e.com","amountCents":5375'
contains "...and the larger one"                         "$FXB" '"toEmail":"a@e.com","amountCents":9837'

DINNER_ID=$(printf '%s' "$DINNER" | grep -o '"id":"[^"]*"' | head -1 | sed 's/^"id":"//;s/"$//')
check "removing the foreign expense"             200 "${AUTH[@]}" -X DELETE "$API/events/$FSLUG/expenses/$DINNER_ID"
FXB2=$(body "${AUTH[@]}" "$API/events/$FSLUG/budget")
contains "...takes exactly its base cents with it"       "$FXB2" '"currency":"CHF","approximate":true,"totalCents":34950'
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
echo "== ...and it is a DEFAULT, not a lock (#59) =="
# What stood here was the other half of #25: a 409 refusing to change the
# instance base while any expense was recorded against a different one. Since
# zäme has no admin-side expense surface, that made the setting permanent on any
# instance with money in it — the exact one-way door #59 removes. The checks are
# therefore inverted: the change SUCCEEDS with expenses recorded, and what has
# to be proved instead is that it reaches forwards only.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  DEF_OWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  # By now the fixtures above have recorded expenses in three currencies. Under
  # #25 this was a 409.
  check "changing the default with expenses recorded" 200 "${DEF_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"EUR"}'
  contains "...moves the default to the value asked for"  "$(body "${DEF_OWNER[@]}" "$BASE/api/admin/settings")" '"baseCurrency":"EUR"'
  DEFTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke default $SUFFIX\",\"type\":\"trip\"}")
  DEFSLUG=$(printf '%s' "$DEFTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  contains "a trip minted after it settles in the NEW default" "$(body "${AUTH[@]}" "$API/events/$DEFSLUG/budget")" '"currency":"EUR"'
  # THE check of the pair. A budget that still read the instance setting rather
  # than its own event's column would answer EUR here, for a trip whose expenses
  # are all frozen against CHF — which is #25's bug wearing #59's hat.
  contains "...while the trip minted before it has not moved" "$(body "${AUTH[@]}" "$API/events/$FSLUG/budget")" '"currency":"CHF"'
  check "...and the default goes back again"         200 "${DEF_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/admin/settings" -d '{"baseCurrency":"CHF"}'
  contains "...without dragging the EUR trip back with it" "$(body "${AUTH[@]}" "$API/events/$DEFSLUG/budget")" '"currency":"EUR"'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

echo "== a total can be split by percentage, by weight or by exact amounts (#26) =="
# The shares are materialised at write time whichever mode was asked for, so a
# balance stays a plain sum and nothing downstream knows there is more than one
# mode. What has to be proved is therefore the ARITHMETIC, executed: every
# assertion below reads the cents out of a real write. A check that inspected
# `resolveShares` would survive the mode being ignored outright.
#
# The fixtures are lopsided ON PURPOSE. An even split of 100.00 across 4 is
# 25/25/25/25 — which is also what weights of 1/1/1/1 give — so a tidy fixture
# proves nothing about weights. Every split below is one the default could not
# have produced.
SPLITTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke splits $SUFFIX\",\"type\":\"trip\"}")
PSLUG=$(printf '%s' "$SPLITTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')

PLAIN=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d "{\"title\":\"Fondue\",\"amountCents\":10000,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT3}")
contains "an expense with no splitMode is recorded as even" "$PLAIN" '"splitMode":"even"'
contains "...and nobody carries a weight nobody typed"      "$PLAIN" '"amountCents":3334,"amountBaseCents":3334,"weight":null'

# "Ana counts double": 2/1/1 of CHF 100.00 is 50/25/25. An even split would be
# 3334/3333/3333, so 5000 is a number only the weight can produce.
WGT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Chalet","amountCents":10000,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"2"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"}]}')
contains "a weighted split gives the double share double" "$WGT" '"amountCents":5000,"amountBaseCents":5000,"weight":"2"'
contains "...and a quarter each to the other two"         "$WGT" '"amountCents":2500,"amountBaseCents":2500,"weight":"1"'
contains "...recording the mode it was split by"          "$WGT" '"splitMode":"weight"'

# A weight of 0 is "not in this one" — and it is the ONLY part of this fixture
# an even split would get wrong, which is why it is the thing asserted.
ZERO=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Lift pass","amountCents":10000,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"1"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"},{"name":"D","email":"d@e.com","weight":"0"}]}')
contains "a weight of 0 leaves somebody out of this one"  "$ZERO" '"email":"d@e.com","amountCents":0,"amountBaseCents":0,"weight":"0"'
contains "...and the remaining three carry the whole lot" "$ZERO" '"email":"a@e.com","amountCents":3334'
check "a split where everybody is weighted out"  422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Nobody","amountCents":10000,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"0"},{"name":"B","email":"b@e.com","weight":"0"}]}'

# By percentage. 50/30/20 of 100.00; an even three-way split cannot make 3000.
PCT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Groceries","amountCents":10000,"splitMode":"percentage","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"50"},{"name":"B","email":"b@e.com","weight":"30"},{"name":"C","email":"c@e.com","weight":"20"}]}')
contains "a percentage split follows the percentages"     "$PCT" '"amountCents":3000,"amountBaseCents":3000,"weight":"30"'
contains "...down to the smallest of them"                "$PCT" '"amountCents":2000,"amountBaseCents":2000,"weight":"20"'
contains "...and keeps what was entered, for the next edit" "$PCT" '"weight":"50"'

# 99 and 101 are refused, and the refusal SAYS WHICH — "that does not add up"
# leaves the person to find the typo among seven numbers.
NINETYNINE='{"title":"Off by one","amountCents":10000,"splitMode":"percentage","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"33"},{"name":"B","email":"b@e.com","weight":"33"},{"name":"C","email":"c@e.com","weight":"33"}]}'
HUNDREDONE='{"title":"Off the other way","amountCents":10000,"splitMode":"percentage","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"34"},{"name":"B","email":"b@e.com","weight":"34"},{"name":"C","email":"c@e.com","weight":"33"}]}'
check "percentages that come to 99 are refused"  422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" -d "$NINETYNINE"
contains "...and the message says 99"                     "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" -d "$NINETYNINE")" 'add up to 99%, not 100%'
check "...and ones that come to 101"             422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" -d "$HUNDREDONE"
contains "...with a message that says 101"                "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" -d "$HUNDREDONE")" 'add up to 101%, not 100%'

# Exact per-person amounts: nothing is inferred, so a typo is refused rather
# than landing quietly on whoever had no amount.
EXACT=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Train tickets","amountCents":10000,"splitMode":"exact","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":6000},{"name":"B","email":"b@e.com","amountCents":3000},{"name":"C","email":"c@e.com","amountCents":1000}]}')
contains "an exact split takes the amounts as given"      "$EXACT" '"amountCents":6000,"amountBaseCents":6000'
contains "...including the smallest of them"              "$EXACT" '"amountCents":1000,"amountBaseCents":1000'
check "an exact split that leaves a gap"         422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Short","amountCents":10000,"splitMode":"exact","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":6000},{"name":"B","email":"b@e.com","amountCents":3000}]}'
check "...and one that names nobody's amount"    422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Vague","amountCents":10000,"splitMode":"exact","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":10000},{"name":"B","email":"b@e.com"}]}'

# Two sources of truth for one share is a refusal, not a preference.
check "a weight beside an amount is refused"     422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Both","amountCents":10000,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"1","amountCents":5000},{"name":"B","email":"b@e.com","weight":"1"}]}'
check "...and a weight on an even split too"     422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PSLUG/expenses" \
  -d '{"title":"Stray","amountCents":10000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"1"},{"name":"B","email":"b@e.com"}]}'

# Seven people and 100.00 — the acceptance case, on its own trip so the balances
# are the whole story. 14.28 x3 + 14.29 x4 is exactly 100, and 1428/1429 is a
# split no even division of this total produces for everybody.
SEVENTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke seven $SUFFIX\",\"type\":\"trip\"}")
VSLUG=$(printf '%s' "$SEVENTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
SEVEN=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$VSLUG/expenses" \
  -d '{"title":"Dinner for seven","amountCents":10000,"splitMode":"percentage","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"14.28"},{"name":"B","email":"b@e.com","weight":"14.28"},{"name":"C","email":"c@e.com","weight":"14.28"},{"name":"D","email":"d@e.com","weight":"14.29"},{"name":"E","email":"e@e.com","weight":"14.29"},{"name":"F","email":"f@e.com","weight":"14.29"},{"name":"G","email":"g@e.com","weight":"14.29"}]}')
contains "seven ways by percentage, to the cent"          "$SEVEN" '"amountCents":1429,"amountBaseCents":1429,"weight":"14.29"'
contains "...and the smaller slices beside them"          "$SEVEN" '"amountCents":1428,"amountBaseCents":1428,"weight":"14.28"'
SEVENB=$(body "${AUTH[@]}" "$API/events/$VSLUG/budget")
# The two balances below are REVERSED from what an even split of this total
# gives. `splitEvenlyCents` hands the four leftover cents to the FIRST four
# people (1429 x4 then 1428 x3); these percentages give the larger slice to the
# LAST four. Asserting the head and the tail therefore fails in both directions
# if the mode is ignored, rather than passing on a number both modes produce.
contains "...so the payer owes the smaller slice, not the larger" "$SEVENB" '"a@e.com","paidCents":10000,"owedCents":1428,"netCents":8572'
contains "...and the last person owes the larger one"     "$SEVENB" '"g@e.com","paidCents":0,"owedCents":1429,"netCents":-1429'

# A weighted split of a FOREIGN expense: the shares have to sum exactly in BOTH
# currencies, and the base ones are NOT in the 2:1:1 ratio the euros are — which
# is the whole reason shares are converted as a group.
#
#   EUR 100.00 at 0.8367 → CHF 83.67
#   spent 5000/2500/2500   base 4183/2092/2092 (sum 8367)
#
# Converting each share on its own would give 4184/2092/2092 = 8368: a cent of
# liability invented, not a residual discovered. #61 keeps the group
# apportionment and leaves the Rounding account with nothing to do.
FXWTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke fx-weight $SUFFIX\",\"type\":\"trip\"}")
WSLUG=$(printf '%s' "$FXWTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
FXW=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$WSLUG/expenses" \
  -d '{"title":"Dinner in Milan","amountCents":10000,"currency":"EUR","fxRate":"0.8367","splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"2"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"}]}')
contains "a weighted foreign split sums in what was SPENT" "$FXW" '"amountCents":5000,"amountBaseCents":4183'
contains "...and in the base it settles for"               "$FXW" '"amountCents":2500,"amountBaseCents":2092'
FXWB=$(body "${AUTH[@]}" "$API/events/$WSLUG/budget")
contains "...to the last cent of the converted total"      "$FXWB" '"currency":"CHF","approximate":true,"totalCents":8367'
contains "...with the balances reconciled in base cents"   "$FXWB" '"a@e.com","paidCents":8367,"owedCents":4183,"netCents":4184'

echo
echo "== the budget is a double-entry ledger with accounts (#61) =="
# Every figure in a budget is now a sum over accounts, so every assertion here
# EXECUTES one against a real Postgres. Three PRs this wave shipped checks that
# passed with the logic they guarded reversed; the mutations these are built to
# redden are named beside them.
#
#   posting every line to Uncategorised   → the category checks below
#   dropping the rounding line            → the imbalance check AND the Rounding one
#   letting an entry not balance          → `ledger_imbalance`, which is 0 or it is nothing
LEDGER=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke ledger $SUFFIX\",\"type\":\"trip\"}")
LSLUG=$(printf '%s' "$LEDGER" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
SPLIT2='[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]'

# No category, and the UI never asks for one: it still has to land somewhere.
PLAIN61=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$LSLUG/expenses" \
  -d "{\"title\":\"Coffee\",\"amountCents\":1200,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT2}")
contains "an expense with no category lands in Uncategorised" "$PLAIN61" '"category":"Uncategorised"'
contains "...on a real account, never a null"                 "$PLAIN61" '"accountKind":"category","accountEmail":null'
# Five lines, not two: the payer's credit, the category debit and credit, and
# one debit per person. A "ledger" that still wrote only the shares has three
# fewer, and every sum over accounts below would then be reading nothing.
equals "...written out as a full entry"          "$(entry_lines "$PLAIN61" Coffee)" "5"

# The old enum still resolves BY NAME, which is what keeps every client
# generated from the previous contract working.
STAY61=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$LSLUG/expenses" \
  -d "{\"title\":\"Chalet\",\"category\":\"accommodation\",\"amountCents\":30000,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT2}")
contains "the old category enum resolves to its account"  "$STAY61" '"category":"Accommodation"'
FOOD61=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$LSLUG/expenses" \
  -d "{\"title\":\"Dinner out\",\"category\":\"Food\",\"amountCents\":8000,\"paidByName\":\"B\",\"paidByEmail\":\"b@e.com\",\"participants\":$SPLIT2}")
contains "...and so does the account's own name"          "$FOOD61" '"category":"Food"'
NOSUCH61="{\"title\":\"Nope\",\"category\":\"Sherpas\",\"amountCents\":100,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT2}"
check "a category the event does not have"       422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$LSLUG/expenses" -d "$NOSUCH61"
contains "...is refused by name, not silently filed"      "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$LSLUG/expenses" -d "$NOSUCH61")" 'has no category called'

LB=$(body "${AUTH[@]}" "$API/events/$LSLUG/budget")
# THE assertion. Every entry's lines sum to zero, in both currencies.
equals "every entry in the budget balances"      "$(ledger_imbalance "$LB")" "0"
# "What did accommodation cost" is the debits into one account. The three
# figures below are three DIFFERENT accounts, so a write that posted everything
# to Uncategorised fails two of them and the third by its amount.
contains "accommodation cost is one account's debits"     "$LB" '"kind":"category","name":"Accommodation","email":null,"isSystem":false,"debitCents":30000'
contains "...food is another's"                           "$LB" '"kind":"category","name":"Food","email":null,"isSystem":false,"debitCents":8000'
contains "...and the uncategorised coffee is its own"     "$LB" '"name":"Uncategorised","email":null,"isSystem":true,"debitCents":1200'
contains "a category nobody used is still an account"     "$LB" '"name":"Tickets","email":null,"isSystem":false,"debitCents":0'
contains "the trip total is the sum of category debits"   "$LB" '"totalCents":39200'
contains "a member account carries the standing"          "$LB" '"kind":"member","name":"A","email":"a@e.com"'
contains "...and nothing has been posted to Rounding"     "$LB" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'

STAY_ID=$(printf '%s' "$STAY61" | grep -o '"id":"[^"]*"' | head -1 | sed 's/^"id":"//;s/"$//')
check "removing the categorised expense"         200 "${AUTH[@]}" -X DELETE "$API/events/$LSLUG/expenses/$STAY_ID"
LB2=$(body "${AUTH[@]}" "$API/events/$LSLUG/budget")
contains "...takes its whole entry with it"               "$LB2" '"name":"Accommodation","email":null,"isSystem":false,"debitCents":0'
contains "...and exactly its cents off the total"         "$LB2" '"totalCents":9200'
equals "...leaving every remaining entry balanced" "$(ledger_imbalance "$LB2")" "0"

echo
echo "== the residual has a home, and this path never gives it anything (#61) =="
# EUR 100.00 at 0.8367, "Ana counts double": 50.00 / 25.00 / 25.00.
#   the total converts to 8367. Converting each share on its own would give
#   4184 + 2092 + 2092 = 8368 — three people severally owing 83.68 for a thing
#   that cost 83.67, and a payer credited 83.68 for handing over 83.67. That is
#   a cent of liability invented, not a residual discovered, so the shares are
#   apportioned as a group and the entry has NO residual at all.
#
# `Rounding` having nothing to do here is the correct answer, not a gap. The
# branch that posts to it is the guarantee that an entry can never be written
# unbalanced, and it is what #59 will need when a currency change recomputes
# per-person amounts that were rounded against a total that no longer exists.
ROUNDTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke rounding $SUFFIX\",\"type\":\"trip\"}")
RSLUG=$(printf '%s' "$ROUNDTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
RESID=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$RSLUG/expenses" \
  -d '{"title":"Milan dinner","amountCents":10000,"currency":"EUR","fxRate":"0.8367","splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"2"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"}]}')
# 4183, not the 4184 that 5000 x 0.8367 rounds to on its own.
contains "the double share is apportioned, not rounded up" "$RESID" '"amountCents":5000,"amountBaseCents":4183'
contains "...and the other two take the rest exactly"     "$RESID" '"amountCents":2500,"amountBaseCents":2092'
# Six lines and no seventh: an entry that needed a rounding line would have one.
equals "...in six lines, with no residual among them" "$(entry_lines "$RESID" "Milan dinner")" "6"
equals "...and it balances, which is the whole invariant" "$(ledger_imbalance "$RESID")" "0"
RB=$(body "${AUTH[@]}" "$API/events/$RSLUG/budget")
equals "...as does every entry in that budget"       "$(ledger_imbalance "$RB")" "0"
contains "the Rounding account is there, holding nothing" "$RB" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'
contains "the trip total is what was SPENT"               "$RB" '"totalCents":8367'
contains "...and the payer is credited what they paid"    "$RB" '"a@e.com","paidCents":8367,"owedCents":4183,"netCents":4184'
contains "...with a debtor owing their apportioned share" "$RB" '"b@e.com","paidCents":0,"owedCents":2092,"netCents":-2092'
contains "the plan clears the whole of one debt"          "$RB" '"toEmail":"a@e.com","amountCents":2092'
# A same-currency expense divides the same way and also writes no extra line.
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$RSLUG/expenses" \
  -d '{"title":"Tram","amountCents":900,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}' > /dev/null
equals "a same-currency split writes no extra line either" "$(entry_lines "$(body "${AUTH[@]}" "$API/events/$RSLUG/budget")" Tram)" "6"
contains "...and Rounding is still empty"                 "$(body "${AUTH[@]}" "$API/events/$RSLUG/budget")" '"name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'

echo
echo "== currency belongs to the TRIP, and what is split is what the payer paid (#59) =="
# Every figure below was worked out by hand in exact decimal and is written here
# as a literal, against a real Postgres. The fixture is LOPSIDED on purpose:
# three equal shares at any rate either all round the same way or all do not, so
# a residual could never appear and half of this block would prove nothing.
#
#   hotel      EUR 245.25, exact 131.00 / 91.70 / 22.55. Ana's bank took
#              CHF 234.00 — the mid-market ~229 plus its cut — so that is what
#              the group owes her, at an effective 0.9541284404, apportioned
#              12499 / 8749 / 2152
#   taxi       GBP  88.40 at a stated 1.1234, weights 3/2/1 -> spent 4420 / 2947
#              / 1473, base 9931 and 4965 / 3311 / 1655
#   groceries  CHF  45.00 even three ways: rate 1, nothing fetched, 1500 each
#
#   trip total 23400 + 9931 + 4500 = 37831 CHF
#   A paid 23400 owes 18964 -> +4436   B paid 9931 owes 13560 -> -3629
#   C paid  4500 owes  5307 ->  -807
#
# Then CHF -> EUR at 1.0865432109, which is where the Rounding account finally
# earns its keep:
#
#   hotel      23400 -> 25425, shares 13581 / 9506 / 2338 summing to 25425
#   taxi        9931 -> 10790, shares  5395 / 3598 / 1798 summing to 10791
#   groceries   4500 ->  4889, shares  1630 x3            summing to  4890
#              -> one cent each on the last two, two in total, and NOT on anyone
#
#   trip total 25425 + 10790 + 4889 = 41104 EUR
#   A paid 25425 owes 20606 -> +4819   B paid 10791 owes 14734 -> -3943
#   C paid  4890 owes  5766 ->  -876
CURTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke currency $SUFFIX\",\"type\":\"trip\"}")
CUSLUG=$(printf '%s' "$CURTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
contains "a new trip takes the instance default as ITS currency" "$(body "${AUTH[@]}" "$API/events/$CUSLUG/budget")" '"currency":"CHF"'

# THE RULE: the amount to split is what the payer was actually out of pocket.
# EUR 245.25 at the mid-market rate is about CHF 229 — the bank charged 234.00,
# and that difference is part of what came out of Ana's account.
HOTEL=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" \
  -d '{"title":"Alpine hotel","amountCents":24525,"currency":"EUR","targetAmountCents":23400,"splitMode":"exact","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":13100},{"name":"B","email":"b@e.com","amountCents":9170},{"name":"C","email":"c@e.com","amountCents":2255}]}')
contains "what the payer actually paid is what is recorded" "$HOTEL" '"amountBaseCents":23400'
contains "...with the receipt itself untouched"            "$HOTEL" '"amountCents":24525,"currency":"EUR"'
contains "...at the EFFECTIVE rate that pair implies"      "$HOTEL" '"fxRate":"0.9541284404"'
contains "...recorded as a figure somebody checked"        "$HOTEL" '"fxRateSource":"manual"'
# AND KEPT AS STATED, beside the derived figure rather than instead of it. The
# settled amount is re-derived by every currency change; this one is not, and it
# is the only place the number somebody typed off a bank statement survives.
contains "...with what was stated kept as it was stated"  "$HOTEL" '"statedAmountCents":23400,"statedCurrency":"CHF"'
contains "...and the shares apportioned from what was PAID" "$HOTEL" '"amountCents":13100,"amountBaseCents":12499'
contains "...down to the smallest of them"                 "$HOTEL" '"amountCents":2255,"amountBaseCents":2152'
equals "...in an entry that balances"            "$(ledger_imbalance "$HOTEL")" "0"

# The two overrides cannot both be given: they can disagree, and there is no
# honest way to pick one.
BOTH='{"title":"Contradiction","amountCents":1000,"currency":"EUR","fxRate":"0.94","targetAmountCents":900,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"}]}'
check "a rate AND a stated total together"       422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" -d "$BOTH"
contains "...is refused rather than quietly resolved" "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" -d "$BOTH")" 'not both'
# Nothing was converted, so there is nothing to override.
SAME='{"title":"Nonsense","amountCents":1000,"targetAmountCents":900,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"}]}'
check "a stated total on an expense in the trip's own currency" 422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" -d "$SAME"
contains "...says so rather than recording an unexplainable number" "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" -d "$SAME")" 'which is what this trip settles in'

TAXI=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" \
  -d '{"title":"Airport taxi","amountCents":8840,"currency":"GBP","fxRate":"1.1234","splitMode":"weight","paidByName":"B","paidByEmail":"b@e.com","participants":[{"name":"A","email":"a@e.com","weight":"3"},{"name":"B","email":"b@e.com","weight":"2"},{"name":"C","email":"c@e.com","weight":"1"}]}')
contains "a typed rate is a manual figure too"   "$TAXI" '"fxRate":"1.1234","fxRateSource":"manual"'
contains "...converted once and frozen"          "$TAXI" '"amountBaseCents":9931'
GROC=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/expenses" \
  -d '{"title":"Groceries","amountCents":4500,"paidByName":"C","paidByEmail":"c@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}')
contains "an expense in the trip's own currency is derived, not stated" "$GROC" '"fxRate":"1","fxRateSource":"fetched"'
contains "...so there is nothing stated about it"         "$GROC" '"fxRateSource":"fetched","statedAmountCents":null,"statedCurrency":null'
# A typed RATE is a statement about money too — the person asserted this receipt
# cost them this much, and multiplying it out is arithmetic, not a lookup.
contains "a typed rate is kept as a stated figure as well" "$TAXI" '"statedAmountCents":9931,"statedCurrency":"CHF"'

CUB=$(body "${AUTH[@]}" "$API/events/$CUSLUG/budget")
contains "the trip totals in ITS currency"       "$CUB" '"currency":"CHF","approximate":true,"totalCents":37831'
contains "A is owed what they fronted less their share" "$CUB" '"a@e.com","paidCents":23400,"owedCents":18964,"netCents":4436'
contains "...B is down theirs"                   "$CUB" '"b@e.com","paidCents":9931,"owedCents":13560,"netCents":-3629'
contains "...and C theirs"                       "$CUB" '"c@e.com","paidCents":4500,"owedCents":5307,"netCents":-807'
contains "nothing has been posted to Rounding yet" "$CUB" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'
equals "every entry balances before the change"  "$(ledger_imbalance "$CUB")" "0"
equals "...and the plan closes exactly"          "$(plan_closes "$CUB")" "closed"

# Changing it. `/api/host`, a session, and owner/co_planner — never the service
# token, and never an account with no standing on the trip.
check "the service token cannot change a trip's currency" 401 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"EUR"}'
if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  check "...nor can an account with no standing on it" 403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"EUR"}'
else
  echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a NON-planner session to run this"
fi

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  CUR_OWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  check "a code that is not three letters"       400 "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"EU"}'
  CHANGED=$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"EUR","fxRate":"1.0865432109"}')
  contains "the planner moves the trip to EUR"   "$CHANGED" '"from":"CHF","to":"EUR"'
  contains "...re-expressing every entry on it"  "$CHANGED" '"entriesRecomputed":3'
  contains "...and saying how many figures somebody had checked" "$CHANGED" '"manualRatesKept":2'

  CUB2=$(body "${AUTH[@]}" "$API/events/$CUSLUG/budget")
  contains "the trip now settles in EUR"         "$CUB2" '"currency":"EUR","approximate":true,"totalCents":41104'
  # THE CONSEQUENCE OF THE RULE, and the reason a stated figure is not snapped
  # back to its own receipt: Ana's hotel bill was EUR 245.25 and the trip now
  # settles in EUR, but she is owed 254.25 — the CHF 234.00 her bank took,
  # re-expressed. Handing her 245.25 would be telling her the fee was her
  # problem.
  contains "a stated figure survives even into its own receipt's currency" "$CUB2" '"amountCents":24525,"currency":"EUR","amountBaseCents":25425'
  contains "...and is still marked as one somebody checked" "$CUB2" '"amountBaseCents":25425,"baseCurrency":"EUR","fxRate":"1.0366972477","fxRateSource":"manual"'
  contains "...with each existing debt re-expressed on its own" "$CUB2" '"amountCents":13100,"amountBaseCents":13581'
  # THE REVIEW'S BLOCKING FINDING, executed. The settled figure moved from 23400
  # CHF to 25425 EUR; what Ana actually told us is still 23400 CHF, so a reader
  # can see that the row labelled "checked against a statement" is now carrying a
  # chained conversion of that statement rather than the statement. Destroying it
  # is the mutation this catches, and there is no recovering it afterwards.
  contains "what the payer stated survives the recomputation" "$CUB2" '"statedAmountCents":23400,"statedCurrency":"CHF"'
  # `currency` and `baseCurrency` are BOTH EUR on that row while the two amounts
  # are nine francs apart, which is why nothing may decide "was this converted"
  # from the two codes.
  contains "...on a row whose two currency codes now agree" "$CUB2" '"currency":"EUR","amountBaseCents":25425,"baseCurrency":"EUR"'
  # THE RESIDUAL. Three debts converted one at a time do not come to the
  # converted bill; the difference is a line, not somebody's share.
  contains "the cents left over land on Rounding" "$CUB2" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":2,"creditCents":0'
  equals "...and every entry still balances"     "$(ledger_imbalance "$CUB2")" "0"
  contains "A is owed the recomputed difference" "$CUB2" '"a@e.com","paidCents":25425,"owedCents":20606,"netCents":4819'
  contains "...B owes theirs"                    "$CUB2" '"b@e.com","paidCents":10791,"owedCents":14734,"netCents":-3943'
  contains "...and C theirs"                     "$CUB2" '"c@e.com","paidCents":4890,"owedCents":5766,"netCents":-876'
  equals "...so the plan still closes to the cent" "$(plan_closes "$CUB2")" "closed"
  contains "the plan clears the smaller debt"    "$CUB2" '"toEmail":"a@e.com","amountCents":876'
  contains "...and the larger one"               "$CUB2" '"toEmail":"a@e.com","amountCents":3943'

  # A BUDGET WHOSE EVERY CODE MATCHES AND WHOSE EVERY FIGURE IS CHAINED. Without
  # its own trip this is unreachable: every other budget here holds a receipt in
  # some other currency, so `approximate` would be true for the wrong reason and
  # the old `currency !== baseCurrency` rule would have passed (#59 review).
  #
  # ONE PARTICIPANT, and that is the load-bearing part. Split two ways, the
  # recompute leaves a cent on `Rounding` and `approximate` comes back true
  # through its OTHER disjunct — so the check passes with the currency-code rule
  # restored and proves nothing. With one share the residual is structurally
  # zero, both `currency` and `baseCurrency` are EUR, and the rate is the only
  # thing left that can answer the question. (Executed: this block was two-way
  # first, and the mutation that puts the codes back went green on it.)
  ALLEUR=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke all-eur $SUFFIX\",\"type\":\"trip\"}")
  AESLUG=$(printf '%s' "$ALLEUR" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$AESLUG/expenses" \
    -d '{"title":"Milan hotel","amountCents":24525,"currency":"EUR","targetAmountCents":23400,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"}]}' > /dev/null
  body "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$AESLUG/currency" -d '{"currency":"EUR","fxRate":"1.0865432109"}' > /dev/null
  AEB=$(body "${AUTH[@]}" "$API/events/$AESLUG/budget")
  # Every expense on it now reads currency EUR, baseCurrency EUR — and every
  # figure under the total is a chained conversion of what somebody typed.
  contains "a trip of EUR receipts settling in EUR"        "$AEB" '"currency":"EUR","amountBaseCents":25425,"baseCurrency":"EUR"'
  contains "...still says its totals are approximate"      "$AEB" '"currency":"EUR","approximate":true,"totalCents":25425'
  excludes "...and does not claim to be exact"             "$AEB" '"approximate":false'
  # …and nothing landed on Rounding, so that `true` came from the RATE and from
  # nothing else. Without this line the check above has two ways to pass.
  contains "...with Rounding holding nothing to explain it" "$AEB" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'

  # BOTH DIRECTIONS, MORE THAN ONCE. 0.9203456789 is this fixture's near-inverse
  # of the rate above, chosen so every figure lands back on itself — which is a
  # property of these numbers and not a promise the arithmetic makes. What it
  # proves is that the residual is RECOMPUTED rather than accumulated: an
  # implementation that carried the old rounding line forward would leave two
  # cents on Rounding here instead of none.
  BACK=$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"CHF","fxRate":"0.9203456789"}')
  contains "and it moves back again"             "$BACK" '"from":"EUR","to":"CHF"'
  CUB3=$(body "${AUTH[@]}" "$API/events/$CUSLUG/budget")
  contains "...landing on the figures it started from" "$CUB3" '"currency":"CHF","approximate":true,"totalCents":37831'
  # The other half of the identity rule: this one was fetched, its receipt is in
  # the currency the trip is back to, so it converts at 1 and its shares are the
  # receipt exactly rather than anything rounded through EUR and back.
  contains "...with the CHF groceries converting at 1 again" "$CUB3" '"amountCents":4500,"currency":"CHF","amountBaseCents":4500,"baseCurrency":"CHF","fxRate":"1"'
  contains "...and Rounding emptied rather than accumulated" "$CUB3" '"kind":"rounding","name":"Rounding","email":null,"isSystem":true,"debitCents":0,"creditCents":0'
  contains "...and every balance back where it was" "$CUB3" '"a@e.com","paidCents":23400,"owedCents":18964,"netCents":4436'
  equals "...still balancing"                    "$(ledger_imbalance "$CUB3")" "0"
  equals "...and still closing"                  "$(plan_closes "$CUB3")" "closed"
  check "changing it to what it already is"      200 "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"CHF"}'
  contains "...is a no-op that recomputes nothing" "$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"CHF"}')" '"entriesRecomputed":0'
  # A currency nobody publishes a rate for, with no rate given: refused, and it
  # names the way through rather than recomputing at a rate nobody chose.
  check "an unquotable currency with no rate"    422 "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"XXX"}'
  contains "...asks for the rate by hand"        "$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$CUSLUG/currency" -d '{"currency":"XXX"}')" 'Enter the rate yourself'
  contains "...and the trip is untouched by the refusal" "$(body "${AUTH[@]}" "$API/events/$CUSLUG/budget")" '"currency":"CHF","approximate":true,"totalCents":37831'

  # THE SURFACES A PERSON ACTUALLY WRITES ON. Everything above went through
  # /api/v1, which is Enterprise's. A friend records an expense through /api/me
  # (the invite page) and a planner through /api/host — three separate zod
  # schemas for one write, and narrowing either human one to drop
  # `targetAmountCents` would leave every check above green (#26 shipped exactly
  # that shape once). The event is published first because /api/me refuses a
  # draft, which is a different refusal and not the one under test here.
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$CUSLUG/status" -d '{"status":"published"}' > /dev/null
  # `expensesRecorded` on /admin/settings is `countRecordedExpenses()`, and it is
  # the only figure that page prints. A version returning 0 would fail nothing,
  # so the check is a DELTA the script chose rather than a value it read back:
  # two expenses go in below, and the count has to move by two.
  RECORDED_BEFORE=$(body "${CUR_OWNER[@]}" "$BASE/api/admin/settings" | sed -n 's/.*"expensesRecorded":\([0-9]*\).*/\1/p')
  MEPAID=$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$CUSLUG/expenses" \
    -d '{"title":"Cable car","amountCents":6000,"currency":"EUR","targetAmountCents":5750,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
  contains "the participant surface takes what was actually paid" "$MEPAID" '"amountBaseCents":5750,"baseCurrency":"CHF","fxRate":"0.9583333333","fxRateSource":"manual"'
  equals "...in an entry that balances"            "$(ledger_imbalance "$MEPAID")" "0"
  HOSTPAID=$(body "${CUR_OWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$CUSLUG/expenses" \
    -d '{"title":"Lift pass","amountCents":9000,"currency":"EUR","targetAmountCents":8600,"paidByName":"B","paidByEmail":"b@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
  contains "...and so does the host surface"       "$HOSTPAID" '"amountBaseCents":8600,"baseCurrency":"CHF","fxRate":"0.9555555556","fxRateSource":"manual"'
  RECORDED_AFTER=$(body "${CUR_OWNER[@]}" "$BASE/api/admin/settings" | sed -n 's/.*"expensesRecorded":\([0-9]*\).*/\1/p')
  equals "the instance expense count moves by what was added" "$((${RECORDED_AFTER:-0} - ${RECORDED_BEFORE:-0}))" "2"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the OWNER's session to run these"
fi

echo "== the chart of accounts, through the surfaces the product writes (#61) =="
# The ledger has to work where PEOPLE write, which is /api/me from the invite
# page and /api/host from the host page — never /api/v1, which is Enterprise's.
# #26 shipped 29 checks entirely on /api/v1 while both human schemas were
# narrow enough to 400 every split a person could make.
ACCTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke accounts $SUFFIX\",\"type\":\"trip\"}")
ASLUG=$(printf '%s' "$ACCTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ASLUG/status" -d '{"status":"published"}' > /dev/null
MEACC="$BASE/api/me/events/$ASLUG/accounts"

check "an anonymous read of the accounts"        401 "$MEACC"
check "a service token is not an account here"   401 "${AUTH[@]}" "$MEACC"

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  PL61=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  MEEXP61="$BASE/api/me/events/$ASLUG/expenses"
  HOSTACC="$BASE/api/host/events/$ASLUG/accounts"

  ACCLIST=$(body "${PL61[@]}" "$MEACC")
  contains "the account surface lists the seeded chart"   "$ACCLIST" '"name":"Uncategorised","email":null,"isSystem":true'
  contains "...including the one nobody sees"             "$ACCLIST" '"kind":"rounding","name":"Rounding"'
  contains "the host surface answers the same chart"      "$(body "${PL61[@]}" "$HOSTACC")" '"name":"Uncategorised","email":null,"isSystem":true'

  # An expense through /api/me, with no category: the ordinary path, and the one
  # the UI takes.
  MEPLAIN=$(body "${PL61[@]}" "${JSON[@]}" -X POST "$MEEXP61" \
    -d "{\"title\":\"Petrol\",\"amountCents\":6000,\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"participants\":$SPLIT2}")
  contains "an expense through /api/me lands in Uncategorised" "$MEPLAIN" '"category":"Uncategorised"'
  equals "...and its entry balances"               "$(ledger_imbalance "$MEPLAIN")" "0"

  # A category the group adds themselves, then posts into by id — the whole
  # "the picker is not shown until they want it" story, executed.
  check "adding a category through /api/me"        201 "${PL61[@]}" "${JSON[@]}" -X POST "$MEACC" -d '{"name":"Ski pass"}'
  ACCLIST2=$(body "${PL61[@]}" "$MEACC")
  contains "...and it joins the chart, not as a system one" "$ACCLIST2" '"kind":"category","name":"Ski pass","email":null,"isSystem":false'
  check "...and a second one by the same name"     409 "${PL61[@]}" "${JSON[@]}" -X POST "$MEACC" -d '{"name":"ski PASS"}'
  SKI_ID=$(account_id "$ACCLIST2" "Ski pass")
  # Named out of alphabetical order, and with the payer in the middle, so the
  # order asserted below is one that neither a sort nor a payer-first rule gives.
  SPLIT3ORD='[{"name":"Cleo","email":"cleo@e.com"},{"name":"Ana","email":"ana@e.com"},{"name":"Ben","email":"ben@e.com"}]'
  MESKI=$(body "${PL61[@]}" "${JSON[@]}" -X POST "$MEEXP61" \
    -d "{\"title\":\"Lift pass\",\"accountId\":\"$SKI_ID\",\"amountCents\":22000,\"paidByName\":\"Ana\",\"paidByEmail\":\"ana@e.com\",\"participants\":$SPLIT3ORD}")
  contains "an expense posted into it lands there"  "$MESKI" '"category":"Ski pass"'
  # The lines come back in the order they were written, so `shares[]` is still
  # the order the split named people in — all seven share one `created_at`, so
  # without `seq` this is whatever Postgres feels like returning.
  equals "...with the shares still in the order given" "$(entry_order "$MESKI" "Lift pass")" "Cleo Ana Ben"
  equals "...and that entry balances too"          "$(ledger_imbalance "$MESKI")" "0"
  contains "...so the new account carries the cost" "$(body "${PL61[@]}" "$MEACC")" '"name":"Ski pass","email":null,"isSystem":false,"debitCents":22000'

  # The two refusals, and they are DIFFERENT refusals. A category holding lines
  # cannot go; Uncategorised cannot go at all.
  check "removing a category that holds lines"     409 "${PL61[@]}" -X DELETE "$MEACC/$SKI_ID"
  contains "...saying which one and why"                  "$(body "${PL61[@]}" -X DELETE "$MEACC/$SKI_ID")" 'still has expenses posted to it'
  # `Uncategorised` is refused OUTRIGHT, holding lines or not: the system check
  # comes first on purpose, because telling somebody to delete every expense on
  # it and then refusing anyway is a worse answer than refusing straight away.
  UNCAT_ID=$(account_id "$ACCLIST2" Uncategorised)
  check "removing Uncategorised while it holds lines" 422 "${PL61[@]}" -X DELETE "$MEACC/$UNCAT_ID"
  contains "...saying it is part of every budget"         "$(body "${PL61[@]}" -X DELETE "$MEACC/$UNCAT_ID")" 'part of every budget'
  TICKETS_ID=$(account_id "$ACCLIST2" Tickets)
  check "removing a category nobody has used"      200 "${PL61[@]}" -X DELETE "$MEACC/$TICKETS_ID"
  ACCLIST3=$(body "${PL61[@]}" "$MEACC")
  equals "...and it is gone from the chart"        "$(account_id "$ACCLIST3" Tickets)" ""
  # …and an EMPTY Uncategorised still cannot go, which is the other half of the
  # rule: a refusal that only fired on the line count would let it through here.
  EMPTYTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke empty $SUFFIX\",\"type\":\"trip\"}")
  ESLUG=$(printf '%s' "$EMPTYTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ESLUG/status" -d '{"status":"published"}' > /dev/null
  EMPTYACC="$BASE/api/me/events/$ESLUG/accounts"
  EUNCAT=$(account_id "$(body "${PL61[@]}" "$EMPTYACC")" Uncategorised)
  check "removing an EMPTY Uncategorised"          422 "${PL61[@]}" -X DELETE "$EMPTYACC/$EUNCAT"
  ERND=$(account_id "$(body "${PL61[@]}" "$EMPTYACC")" Rounding)
  check "...and removing Rounding"                 422 "${PL61[@]}" -X DELETE "$EMPTYACC/$ERND"

  # The host surface writes the same ledger, and the residual reaches it too.
  HOSTFX=$(body "${PL61[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$ESLUG/expenses" \
    -d '{"title":"Milan again","amountCents":10000,"currency":"EUR","fxRate":"0.8367","splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"2"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"}]}')
  contains "the HOST surface apportions the same way"     "$HOSTFX" '"amountCents":5000,"amountBaseCents":4183'
  equals "...and its entry balances as well"       "$(ledger_imbalance "$HOSTFX")" "0"
  contains "...with the total what was spent"             "$HOSTFX" '"totalCents":8367'
  check "adding a category on the host surface"    201 "${PL61[@]}" "${JSON[@]}" -X POST "$HOSTACC" -d '{"name":"Petrol"}'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
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

  # THE TWO SURFACES THE PRODUCT ACTUALLY WRITES TO (#26). `BudgetCard.vue`
  # posts to /api/me on the invite page and to /api/host on the host page, and
  # BOTH schemas gained a `splitMode` enum and a `weight` regex. The /api/v1
  # block above cannot exercise either: it posts a third schema with a third
  # credential. Narrow these two to `['even','exact']` with a `weight` regex
  # matching nothing and every percentage and weight split a PERSON makes 400s,
  # while vitest, the typecheck and the smoke floor all stay green. These four
  # checks are the only thing that notices.
  MEW='{"title":"Chalet by weight","amountCents":10000,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"2"},{"name":"B","email":"b@e.com","weight":"1"},{"name":"C","email":"c@e.com","weight":"1"}]}'
  MEP99='{"title":"Off by one","amountCents":10000,"splitMode":"percentage","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"33"},{"name":"B","email":"b@e.com","weight":"33"},{"name":"C","email":"c@e.com","weight":"33"}]}'
  contains "a weighted split over the ACCOUNT surface" "$(body "${PLANNER[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$MEW")" '"amountCents":5000,"amountBaseCents":5000,"weight":"2"'
  # 422 and not 400: the refusal has to come from the DOMAIN, having understood
  # the mode, rather than from a schema that never let it through.
  check "...and 99% is refused there by the domain" 422 "${PLANNER[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$MEP99"
  contains "...naming the sum on that surface too"  "$(body "${PLANNER[@]}" "${JSON[@]}" -X POST "$MEEXP" -d "$MEP99")" 'add up to 99%, not 100%'
  contains "a weighted split over the HOST surface"    "$(body "${PLANNER[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$TSLUG/expenses" -d "$MEW")" '"amountCents":5000,"amountBaseCents":5000,"weight":"2"'

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
echo "== an expense can be corrected, not only added and deleted (Bermos/zaeme#27) =="
# EVERY FIGURE HERE WAS WORKED OUT BY HAND in exact integers and is written as a
# literal, against a real Postgres. The fixtures are LOPSIDED on purpose: a
# weight split of 1/1/1 IS an even split, and a total that divides cleanly hides
# a dropped remainder, so neither could tell a re-split that reads what #26
# recorded from one that ignores it and splits evenly.
#
#   Ski pass      even, four ways, CHF 100.00 -> 25.00 each. Corrected to
#                 120.00: 30.00 each, and not 25.00 each with an orphaned 20.00
#   Airport taxi  weight 3/2/1 of CHF 88.40 -> 44.20 / 29.47 / 14.73. Corrected
#                 to 100.01: 50.00 / 33.34 / 16.67. The two leftover cents land
#                 on the SMALLEST shares; an even split of that same total is
#                 33.34 / 33.34 / 33.33, so the two answers differ in every
#                 position and neither is a rounding of the other
#   Groceries     percentage 70/20/10 of CHF 100.00. Corrected to 44.44:
#                 31.11 / 8.89 / 4.44
#   Museum        exact 60.00 / 30.00 / 10.00. A new total is REFUSED — those
#                 amounts were chosen against a total that no longer exists
#   Fondue        even with Ana pinned at 40.00 of 100.00 -> 40 / 30 / 30. A new
#                 total is REFUSED as well, because WHICH participants were
#                 pinned is recorded nowhere (#26, #60) — but a new title is not
#   Alpine hotel  EUR 245.25 stated at CHF 234.00, an effective 0.9541284404.
#                 Corrected to EUR 200.00 with nothing else said: 200.00 at that
#                 rate is 190.82568808 -> CHF 190.83, and the row stops claiming
#                 it was checked against a statement
ETRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke edit $SUFFIX\",\"type\":\"trip\"}")
ESLUG=$(printf '%s' "$ETRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
EEXP="$API/events/$ESLUG/expenses"
echo "  trip: $ESLUG"

SKI=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Ski pass","amountCents":10000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"},{"name":"D","email":"d@e.com"}]}')
SKI_ID=$(expense_id "$SKI" "Ski pass")
equals "an even split starts where it always did" "$(entry_shares "$SKI" "Ski pass")" "2500 2500 2500 2500"
check "correcting the total of an even split"     200 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"amountCents":12000}'
SKI2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"amountCents":12000}')
equals "...re-splits it evenly at the NEW total"  "$(entry_shares "$SKI2" "Ski pass")" "3000 3000 3000 3000"
equals "...in an entry that still balances"       "$(ledger_imbalance "$SKI2")" "0"
contains "...under the id it was recorded with"   "$SKI2" "\"id\":\"$SKI_ID\""
contains "...at rate 1, the trip's own currency"  "$SKI2" '"amountCents":12000,"currency":"CHF","amountBaseCents":12000,"baseCurrency":"CHF","fxRate":"1","fxRateSource":"fetched","statedAmountCents":null,"statedCurrency":null'

TAXI=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Airport taxi","amountCents":8840,"splitMode":"weight","paidByName":"B","paidByEmail":"b@e.com","participants":[{"name":"A","email":"a@e.com","weight":"3"},{"name":"B","email":"b@e.com","weight":"2"},{"name":"C","email":"c@e.com","weight":"1"}]}')
TAXI_ID=$(expense_id "$TAXI" "Airport taxi")
equals "a weighted split starts lopsided"         "$(entry_shares "$TAXI" "Airport taxi")" "4420 2947 1473"
TAXI2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$TAXI_ID" -d '{"amountCents":10001}')
# THE CHECK THIS BLOCK EXISTS FOR. An implementation that re-split evenly rather
# than at the recorded weights answers 3334 3334 3333 here, which is neither a
# rounding nor a permutation of the right answer.
equals "correcting its total re-applies the WEIGHTS" "$(entry_shares "$TAXI2" "Airport taxi")" "5000 3334 1667"
equals "...and hands them back for the next edit"    "$(entry_weights "$TAXI2" "Airport taxi")" "3 2 1"
equals "...in an entry that still balances"          "$(ledger_imbalance "$TAXI2")" "0"

GROC=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Groceries","amountCents":10000,"splitMode":"percentage","paidByName":"C","paidByEmail":"c@e.com","participants":[{"name":"A","email":"a@e.com","weight":"70"},{"name":"B","email":"b@e.com","weight":"20"},{"name":"C","email":"c@e.com","weight":"10"}]}')
GROC_ID=$(expense_id "$GROC" "Groceries")
equals "a percentage split starts at its percentages" "$(entry_shares "$GROC" "Groceries")" "7000 2000 1000"
GROC2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$GROC_ID" -d '{"amountCents":4444}')
equals "...and re-applies them at the new total"      "$(entry_shares "$GROC2" "Groceries")" "3111 889 444"
equals "...with the percentages still recorded"       "$(entry_weights "$GROC2" "Groceries")" "70 20 10"

MUS=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Museum","amountCents":10000,"splitMode":"exact","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":6000},{"name":"B","email":"b@e.com","amountCents":3000},{"name":"C","email":"c@e.com","amountCents":1000}]}')
MUS_ID=$(expense_id "$MUS" "Museum")
check "a new total on an EXACT split"             422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$MUS_ID" -d '{"amountCents":12000}'
contains "...says the amounts have to come with it" "$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$MUS_ID" -d '{"amountCents":12000}')" 'split by exact amounts'
# The refusal REFUSED: 72.00 / 36.00 / 12.00 is what apportioning those amounts
# to the new total would have produced, and it is a proportional split nobody
# asked for from amounts that meant "Ana's ticket, Ben's, Cy's".
equals "...and nothing at all was written"        "$(entry_shares "$(body "${AUTH[@]}" "$API/events/$ESLUG/budget")" "Museum")" "6000 3000 1000"
MUS2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$MUS_ID" \
  -d '{"amountCents":12000,"splitMode":"exact","participants":[{"name":"A","email":"a@e.com","amountCents":7200},{"name":"B","email":"b@e.com","amountCents":3600},{"name":"C","email":"c@e.com","amountCents":1200}]}')
equals "...while amounts sent WITH the total are taken" "$(entry_shares "$MUS2" "Museum")" "7200 3600 1200"

FON=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Fondue","amountCents":10000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":4000},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}')
FON_ID=$(expense_id "$FON" "Fondue")
equals "an even split can have an amount pinned by hand" "$(entry_shares "$FON" "Fondue")" "4000 3000 3000"
check "a new total on a MIXED even split"         422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$FON_ID" -d '{"amountCents":12000}'
contains "...says which people were pinned was never recorded" "$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$FON_ID" -d '{"amountCents":12000}')" 'fixed by hand'
# ...and the total that did NOT move needs no re-split at all, which is what
# lets the one unrecoverable case still have its title corrected.
FON2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$FON_ID" -d '{"title":"Fondue night"}')
equals "...but correcting only its title leaves the shares alone" "$(entry_shares "$FON2" "Fondue night")" "4000 3000 3000"
FON3=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$FON_ID" \
  -d '{"amountCents":12000,"splitMode":"even","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}')
equals "...and sending the split with the total works" "$(entry_shares "$FON3" "Fondue night")" "4000 4000 4000"

# ---- what an edit does to the conversion, and to the evidence behind it ----
HOTEL=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$EEXP" \
  -d '{"title":"Alpine hotel","amountCents":24525,"currency":"EUR","targetAmountCents":23400,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
H_ID=$(expense_id "$HOTEL" "Alpine hotel")
contains "a stated figure is recorded as one somebody checked" "$HOTEL" '"amountBaseCents":23400,"baseCurrency":"CHF","fxRate":"0.9541284404","fxRateSource":"manual","statedAmountCents":23400,"statedCurrency":"CHF"'
H1=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"title":"Alpine hotel, night 1"}')
# THE EVIDENCE RULE, half one: an edit that touches no money must not re-fetch a
# rate over a figure a person verified against their bank statement.
contains "correcting the title leaves the conversion untouched" "$H1" '"amountBaseCents":23400,"baseCurrency":"CHF","fxRate":"0.9541284404","fxRateSource":"manual","statedAmountCents":23400,"statedCurrency":"CHF"'
H2=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"amountCents":20000}')
contains "correcting the amount keeps the rate it was frozen at" "$H2" '"amountCents":20000,"currency":"EUR","amountBaseCents":19083,"baseCurrency":"CHF","fxRate":"0.9541284404"'
# ...and half two: the figure somebody stated was about a receipt that has just
# been declared wrong, so the row stops claiming to have been checked rather
# than carrying that statement onto a number nobody stated.
contains "...and the row stops claiming it was checked" "$H2" '"fxRate":"0.9541284404","fxRateSource":"fetched","statedAmountCents":null,"statedCurrency":null'
equals "...in an entry that still balances"       "$(ledger_imbalance "$H2")" "0"
equals "...with the receipt re-split across the two of them" "$(entry_shares "$H2" "Alpine hotel, night 1")" "10000 10000"
contains "...and the base shares apportioned as a group" "$H2" '"amountCents":10000,"amountBaseCents":9542'
H3=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"targetAmountCents":19000}')
contains "saying again what was paid makes it checked again" "$H3" '"amountBaseCents":19000,"baseCurrency":"CHF","fxRate":"0.95","fxRateSource":"manual","statedAmountCents":19000,"statedCurrency":"CHF"'
check "a rate AND a stated total on an edit"      422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"fxRate":"0.9","targetAmountCents":18000}'
contains "...is refused exactly as it is on a write" "$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"fxRate":"0.9","targetAmountCents":18000}')" 'not both'
H4=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$H_ID" -d '{"currency":"GBP","fxRate":"1.2345678901"}')
contains "changing the receipt's currency settles it afresh" "$H4" '"amountCents":20000,"currency":"GBP","amountBaseCents":24691,"baseCurrency":"CHF","fxRate":"1.2345678901","fxRateSource":"manual"'
equals "...still balancing"                       "$(ledger_imbalance "$H4")" "0"

# ---- absent is not null, and neither of them is "whatever the default is" ----
EFOOD=$(account_id "$(body "${AUTH[@]}" "$API/events/$ESLUG/budget")" "Food")
SKI3=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d "{\"accountId\":\"$EFOOD\"}")
contains "an edit can move a cost into a category" "$SKI3" '"category":"Food"'
SKI4=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"note":"six days, lift included"}')
# THE MUTATION THIS CATCHES is one line: resolving the category unconditionally
# rather than only when the edit mentions it. Every other check here passes with
# it, and every expense anybody edits quietly leaves its category.
contains "...and an edit that says nothing about it leaves it there" "$SKI4" '"category":"Food"'
contains "...while the note it DID say lands"     "$SKI4" '"note":"six days, lift included"'
SKI5=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"note":null}')
contains "a null note clears it"                  "$SKI5" '"note":null'
contains "...without disturbing the category"     "$SKI5" '"category":"Food"'
SKI6=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"accountId":null}')
contains "a null category moves the cost back to Uncategorised" "$SKI6" '"category":"Uncategorised"'

# ---- the payer, and the two refusals that keep an edit honest ----
TAXI3=$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$TAXI_ID" -d '{"paidByName":"Cy","paidByEmail":"c@e.com"}')
contains "an edit can move who fronted the money"  "$TAXI3" '"paidByName":"Cy","paidByEmail":"c@e.com"'
# BY EMAIL, because that is the identity. The entry HEADER records "Cy", which
# is what was typed, while the member ACCOUNT goes on saying "C": `addExpense`
# and this both hand `ensureMemberAccountsWithin` the payer FOLLOWED BY the
# split, its map is keyed on the address, and the last name written wins — so a
# payer who is also in the split is named by the split. Asserted on the address
# so this check is about the money moving and not about that.
contains "...crediting the new payer the whole entry" "$TAXI3" '"accountKind":"member","accountEmail":"c@e.com","amountCents":-10001'
excludes "...and taking that credit off the old one" "$TAXI3" '"accountEmail":"b@e.com","amountCents":-10001'
equals "...while the split stays exactly where it was" "$(entry_shares "$TAXI3" "Airport taxi")" "5000 3334 1667"
equals "...in an entry that still balances"        "$(ledger_imbalance "$TAXI3")" "0"
check "half a payer"                               422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$TAXI_ID" -d '{"paidByEmail":"d@e.com"}'
contains "...is refused, naming both halves"       "$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$TAXI_ID" -d '{"paidByEmail":"d@e.com"}')" 'both their name and their email'
check "a split MODE with no split behind it"       422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"splitMode":"percentage"}'
contains "...says to send the participants with it" "$(body "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"splitMode":"percentage"}')" 'needs the split itself'
check "correcting an expense that is not there"    404 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$API/events/$ESLUG/expenses/nope_not_an_id" -d '{"title":"x"}'
check "an unknown field on the machine surface"    422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"nope":1}'
check "a total of nothing"                         422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"amountCents":0}'
check "an anonymous correction"                    401 "${JSON[@]}" -X PATCH "$BASE/api/me/events/$ESLUG/expenses/$SKI_ID" -d '{"title":"x"}'
check "...and a service token on the human surface" 401 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/me/events/$ESLUG/expenses/$SKI_ID" -d '{"title":"x"}'
check "...and a service token on the host one"     401 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$ESLUG/expenses/$SKI_ID" -d '{"title":"x"}'

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ] && [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  EOWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  EGUEST=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")
  MEEXPE="$BASE/api/me/events/$ESLUG/expenses"
  HOSTEXPE="$BASE/api/host/events/$ESLUG/expenses"
  check "a guest session cannot correct through /api/v1" 401 "${EGUEST[@]}" "${JSON[@]}" -X PATCH "$EEXP/$SKI_ID" -d '{"title":"x"}'
  # Signed in and real, with no RSVP and no planner row on this trip — 403 and
  # not 401: the credential is fine, the standing is not. It runs BEFORE the
  # RSVP below, which is the thing that gives this account standing.
  check "a signed-in account with no standing on the trip" 403 "${EGUEST[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$SKI_ID" -d '{"title":"nope"}'

  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ESLUG/status" -d '{"status":"published"}' > /dev/null
  ETOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$ESLUG/invites" -d '{"label":"Edit smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  EGEMAIL=$(body "${EGUEST[@]}" "$BASE/api/auth/get-session" | grep -o '"email":"[^"]*"' | head -1 | sed 's/^"email":"//;s/"$//')
  body "${JSON[@]}" -X POST "$BASE/api/invites/$ETOK/rsvp" \
    -d "{\"status\":\"yes\",\"guestName\":\"CI Guest\",\"guestEmail\":\"$EGEMAIL\"}" > /dev/null

  # THE SURFACES A PERSON ACTUALLY WRITES ON. `BudgetCard.vue` PATCHes
  # `${expensesBase}/{id}` — /api/me on the invite page, /api/host on the host
  # page — which is two more zod schemas for one verb, neither of them the one
  # everything above went through. #26 shipped exactly this shape once: 29
  # checks on /api/v1 while both human schemas were broken.
  EW='{"title":"Chalet","amountCents":8840,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"3"},{"name":"B","email":"b@e.com","weight":"2"},{"name":"C","email":"c@e.com","weight":"1"}]}'
  CHALET=$(body "${EOWNER[@]}" "${JSON[@]}" -X POST "$MEEXPE" -d "$EW")
  CH_ID=$(expense_id "$CHALET" "Chalet")
  CH2=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$CH_ID" -d '{"amountCents":10001}')
  equals "the ACCOUNT surface re-splits at the recorded weights" "$(entry_shares "$CH2" "Chalet")" "5000 3334 1667"
  equals "...keeping the weights on it"             "$(entry_weights "$CH2" "Chalet")" "3 2 1"
  equals "...in an entry that still balances"       "$(ledger_imbalance "$CH2")" "0"
  # Its OWN mixed entry, because "Fondue night" above has since been given an
  # explicit even split and is no longer one — a refusal check pointed at an
  # entry that has stopped being the refusable case passes for the wrong reason.
  RAC=$(body "${EOWNER[@]}" "${JSON[@]}" -X POST "$MEEXPE" \
    -d '{"title":"Raclette","amountCents":10000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","amountCents":4000},{"name":"B","email":"b@e.com"},{"name":"C","email":"c@e.com"}]}')
  RAC_ID=$(expense_id "$RAC" "Raclette")
  check "...and a mixed even split is refused there too" 422 "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$RAC_ID" -d '{"amountCents":15000}'
  # 422 and not 400: the refusal comes from the DOMAIN, having read the shares,
  # rather than from a schema that never let the field through.
  contains "...with the domain's own message behind it" "$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$RAC_ID" -d '{"amountCents":15000}')" 'fixed by hand'

  EH='{"title":"Lift pass","amountCents":8840,"splitMode":"weight","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com","weight":"3"},{"name":"B","email":"b@e.com","weight":"2"},{"name":"C","email":"c@e.com","weight":"1"}]}'
  LIFT=$(body "${EOWNER[@]}" "${JSON[@]}" -X POST "$HOSTEXPE" -d "$EH")
  LF_ID=$(expense_id "$LIFT" "Lift pass")
  LF2=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$HOSTEXPE/$LF_ID" -d '{"amountCents":10001}')
  equals "...and so does the HOST surface"          "$(entry_shares "$LF2" "Lift pass")" "5000 3334 1667"
  equals "...with the weights on it there too"      "$(entry_weights "$LF2" "Lift pass")" "3 2 1"

  # THE ACCEPTANCE CRITERION, executed. The guest account has an RSVP on this
  # trip and nothing else: it did not record "Chalet", it did not pay it, and it
  # does not plan the event. It may still correct it.
  check "a participant corrects an expense somebody ELSE recorded" 200 "${EGUEST[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$CH_ID" -d '{"title":"Chalet, 3 nights"}'
  contains "...and the correction is actually on the budget" "$(body "${AUTH[@]}" "$API/events/$ESLUG/budget")" '"title":"Chalet, 3 nights"'
  # ...and may STILL not delete it, which is the asymmetry #27 chose on purpose:
  # a wrong figure fixed by the wrong person is still fixed, and a wrong
  # deletion is undoable by nobody.
  check "...and still may not delete it"            403 "${EGUEST[@]}" -X DELETE "$MEEXPE/$CH_ID"

  # WHO CHANGED IT is the audit's answer and not a column on the expense, so
  # this is the only place the attribution can be read back at all.
  EAUD=$(audit_await "$BASE/api/admin/audit?actorKind=participant&surface=me&eventSlug=$ESLUG&limit=20" \
    "\"path\":\"/api/me/events/$ESLUG/expenses/$CH_ID\"")
  contains "the audit records the correction, by path" "$EAUD" "\"path\":\"/api/me/events/$ESLUG/expenses/$CH_ID\""
  contains "...against the account that made it, not the one that recorded it" "$EAUD" "\"actorLabel\":\"$EGEMAIL\""
else
  echo "  skip  set both ZAEME_TEST_SESSION_COOKIE and ZAEME_TEST_GUEST_COOKIE to run these"
fi

echo
echo "== places, and the legs between them (Bermos/zaeme#30) =="
# An itinerary was a sorted list of strings until now: one free-text location
# per item, no pin, and nothing to say that the 09:14 connects two of them.
# Everything below EXECUTES that against a real Postgres, because almost none of
# it is decidable from the source: the delete cascade is three statements in a
# transaction, the reorder is one `row_number()` renumbering, and the guest
# write is a capability URL resolving to an event. `pnpm test` pins the
# coordinate rule and the merged order, which are the only pure parts.
#
# BOTH SURFACES THE PRODUCT WRITES TO, deliberately (#60's lesson): the host
# session on /api/host and the invite link on /api/invites, which are two
# separate zod schemas and two different credentials for one feature. Proving
# one says nothing about the other — and `isPlanned` means the OPPOSITE thing by
# default on each, which is the pair of checks that catches a single shared
# default.
GEOTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke places $SUFFIX\",\"type\":\"trip\"}")
GSLUG=$(printf '%s' "$GEOTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG/status" -d '{"status":"published"}' > /dev/null
GTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG/invites" -d '{"label":"Places smoke"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
# A second trip, so "a place from another trip" is a real id and not a typo.
OTHERTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke elsewhere $SUFFIX\",\"type\":\"trip\"}")
OSLUG3=$(printf '%s' "$OTHERTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
HPLACES="$BASE/api/host/events/$GSLUG/places"
HLEGS="$BASE/api/host/events/$GSLUG/legs"
echo "  trip: $GSLUG"

check "a place needs a session"                  401 "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Nope"}'
check "...and a service token is not one"        401 "${AUTH[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Nope"}'
# The constraint #30 says is the one most likely to be got wrong: Enterprise
# generates its MCP tools from the contract, so a route here would be a verb
# nobody decided to give the model. `pnpm test` asserts the spec and the route
# tree; this asserts the running server answers nothing there.
check "the map is not on the machine API"        404 "${AUTH[@]}" "$API/events/$GSLUG/places"
check "...and neither are the legs"              404 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG/legs" -d '{}'

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  PLN=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")

  P1=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Zug HB","address":"Bahnhofplatz","lat":"47.1742","lng":"8.5153"}')
  contains "a place with coordinates"                   "$P1" '"name":"Zug HB","address":"Bahnhofplatz"'
  # NUMBERS, not the padded strings the driver hands back for numeric(9,6) —
  # a map takes [lat, lng] and a distance is trigonometry, so every consumer
  # would otherwise have to remember to parse, and the one that forgot would
  # concatenate instead of adding.
  contains "...answered as numbers, not driver strings" "$P1" '"lat":47.1742,"lng":8.5153'

  # THE STATE THIS TABLE EXISTS TO KEEP: "Ana's flat" is a place, and #32 has to
  # be able to leave it alone.
  P2=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Hotel Bellevue"}')
  contains "a place with NO coordinates at all"         "$P2" '"name":"Hotel Bellevue","address":null,"lat":null,"lng":null'
  body "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Lakeside"}' > /dev/null

  HALF='{"name":"Half","lat":"47.1"}'
  check "half a coordinate is refused"             422 "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d "$HALF"
  contains "...and says both or neither"                "$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d "$HALF")" 'both a latitude and a longitude, or neither'
  check "a latitude that is not on the planet"     422 "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Off","lat":"91","lng":"0"}'
  check "...and a longitude that is not either"    422 "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Off","lat":"0","lng":"181"}'

  PID1=$(place_id "$P1" "Zug HB")
  PID2=$(place_id "$P2" "Hotel Bellevue")
  PID3=$(place_id "$(body "${PLN[@]}" "$HPLACES")" "Lakeside")
  # A fourth place, carrying a note of the kind a host actually writes. It is
  # never an endpoint until the last check in this block, so it changes none of
  # the delete arithmetic below — it is here to be looked for in what the invite
  # link carries.
  P4=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HPLACES" -d '{"name":"Museum","note":"lockbox 4417, back door"}')
  PID4=$(place_id "$P4" "Museum")

  # "Coordinates added later" is an acceptance criterion, and the value below is
  # the one this script ROUNDED BY HAND: 47.3768866 is what a geocoder answers
  # and 47.376887 is what numeric(9,6) holds — about 11 cm.
  LATER=$(body "${PLN[@]}" "${JSON[@]}" -X PATCH "$HPLACES/$PID2" -d '{"lat":"47.3768866","lng":"8.5416578"}')
  contains "coordinates can be added later"             "$LATER" '"name":"Hotel Bellevue","address":null,"lat":47.376887,"lng":8.541658'
  equals "...to the same place, not a new one"     "$(place_id "$LATER" "Hotel Bellevue")" "$PID2"

  OPLACE=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$OSLUG3/places" -d '{"name":"Another trip entirely"}')
  OPID=$(place_id "$OPLACE" "Another trip entirely")

  # Legs. The first is TIMED and carries everything a person can say about one;
  # the three after it have no clock, which is the block the arrows act on.
  L1=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" \
    -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID2\",\"mode\":\"train\",\"departsAt\":\"2027-06-01T09:14:00+02:00\",\"durationMinutes\":42,\"note\":\"IR 2313\"}")
  contains "a leg joins two places, by name"            "$L1" '"fromPlaceName":"Zug HB","toPlaceName":"Hotel Bellevue"'
  contains "...keeping the mode and the note"           "$L1" '"mode":"train"'
  # The host means the PLAN when it says nothing, and the guest link means what
  # HAPPENED. One shared default satisfies one of these two and not both.
  contains "...and a host leg is the PLAN by default"   "$L1" '"isPlanned":true'
  body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID2\",\"toPlaceId\":\"$PID3\",\"mode\":\"walk\"}" > /dev/null
  body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID3\",\"toPlaceId\":\"$PID1\",\"mode\":\"bus\"}" > /dev/null
  body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID3\",\"mode\":\"bike\"}" > /dev/null

  check "a leg to the same place it starts at"     422 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID1\",\"mode\":\"walk\"}"
  check "a leg that arrives before it departs"     422 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" \
    -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID2\",\"mode\":\"train\",\"departsAt\":\"2027-06-01T09:14:00+02:00\",\"arrivesAt\":\"2027-06-01T08:00:00+02:00\"}"
  # The composite foreign key would refuse this as a 500 from the driver; the
  # domain refuses it as a sentence.
  check "a leg ending at another trip's place"     422 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$OPID\",\"mode\":\"car\"}"
  contains "...and says whose place it is not"          "$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$OPID\",\"mode\":\"car\"}")" 'not on this event'

  # RE-ORDERING, EXECUTED. This is the only evidence `applyItineraryLegMove`
  # computes the right thing: deleting its transposition, pinning its delta, or
  # dropping the `event_id` scoping so one move renumbers every trip on the
  # instance are all invisible to vitest. The four legs form a LOOP on purpose —
  # every one has a different pair of endpoints, so a wrong answer reads
  # differently rather than coincidentally the same.
  GEO=$(body "${PLN[@]}" "$HPLACES")
  LEG_T=$(leg_id_by_route "$GEO" "Zug HB" "Hotel Bellevue")
  LEG_C=$(leg_id_by_route "$GEO" "Zug HB" "Lakeside")
  LEG_B=$(leg_id_by_route "$GEO" "Lakeside" "Zug HB")
  equals "four legs, the timed one first"          "$(leg_route "$GEO")" "Zug HB>Hotel Bellevue Hotel Bellevue>Lakeside Lakeside>Zug HB Zug HB>Lakeside"
  equals "...numbered ten apart"                   "$(leg_orders "$GEO")" "0 10 20 30"

  MOVED=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_C/move" -d '{"direction":"up"}')
  equals "moving one up transposes it with its neighbour" "$(leg_route "$MOVED")" "Zug HB>Hotel Bellevue Hotel Bellevue>Lakeside Zug HB>Lakeside Lakeside>Zug HB"
  # The untimed block is renumbered 0/10/20 while the timed leg keeps the number
  # it was created with, because `sort_order` is the manual order among the legs
  # that have no clock and nothing else. A statement that renumbered every leg
  # would answer "0 10 20 30" here.
  equals "...renumbering the untimed block only"   "$(leg_orders "$MOVED")" "0 0 10 20"
  MOVED2=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_C/move" -d '{"direction":"up"}')
  equals "...again, and it leads the untimed ones" "$(leg_route "$MOVED2")" "Zug HB>Hotel Bellevue Zug HB>Lakeside Hotel Bellevue>Lakeside Lakeside>Zug HB"
  check "moving it up once more is a no-op"        200 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_C/move" -d '{"direction":"up"}'
  NOOP=$(body "${PLN[@]}" "$HPLACES")
  equals "...and cannot lift it above a timed leg" "$(leg_route "$NOOP")" "Zug HB>Hotel Bellevue Zug HB>Lakeside Hotel Bellevue>Lakeside Lakeside>Zug HB"
  equals "...with the numbering still total"       "$(leg_orders "$NOOP")" "0 0 10 20"
  # The arrows do not exist on a timed leg (the host card hides them and says
  # why), and the domain refuses it rather than renumbering a column no screen
  # reads — which would be a 200 and a leg that does not move.
  check "a timed leg cannot be moved by hand"      422 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_T/move" -d '{"direction":"up"}'
  contains "...and says what orders it instead"         "$(body "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_T/move" -d '{"direction":"up"}')" 'ordered by its departure time'
  check "a leg that is not on this trip"           404 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/no-such-leg/move" -d '{"direction":"up"}'
  check "a direction that is not up or down"       400 "${PLN[@]}" "${JSON[@]}" -X POST "$HLEGS/$LEG_C/move" -d '{"direction":"sideways"}'

  # THE CLOCK WINS, AND BOTH SURFACES AGREE ABOUT IT. Giving the bus a departure
  # of 08:00 moves it to the FRONT — it holds `sort_order` 20, the last of the
  # untimed block, so this is the one arrangement the old rule (`sort_order`
  # first) could not produce. Asserted on the host card's read AND on the invite
  # payload the guest itinerary is rendered from: while those two disagreed, a
  # planner could reorder a timed leg, watch it move on /host, open the invite
  # link and find that nothing had.
  body "${PLN[@]}" "${JSON[@]}" -X PATCH "$HLEGS/$LEG_B" -d '{"departsAt":"2027-06-01T08:00:00+02:00"}' > /dev/null
  BYCLOCK="Lakeside>Zug HB Zug HB>Hotel Bellevue Zug HB>Lakeside Hotel Bellevue>Lakeside"
  equals "a leg given a time moves to its time"    "$(leg_route "$(body "${PLN[@]}" "$HPLACES")")" "$BYCLOCK"
  equals "...and the GUEST itinerary reads the same" "$(leg_route "$(body "$BASE/api/invites/$GTOK")")" "$BYCLOCK"

  # The itinerary item keeps its free text AND gains a pin — the criterion that
  # an item with only a location renders exactly as it did before #30.
  PINNED=$(body "${PLN[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$GSLUG/timeline" \
    -d "{\"title\":\"Check in\",\"location\":\"the front desk\",\"placeId\":\"$PID2\"}")
  contains "an itinerary item can be pinned to a place" "$PINNED" "\"placeId\":\"$PID2\""
  contains "...and keeps its free-text location too"    "$PINNED" '"location":"the front desk"'
  ITEMID=$(printf '%s' "$PINNED" | sed -n 's/.*"item":{"id":"\([^"]*\)".*/\1/p')
  check "an item pinned to another trip's place"   422 "${PLN[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$GSLUG/timeline/$ITEMID" -d "{\"placeId\":\"$OPID\"}"

  # THE GUEST HALF. "We ended up walking" happens while the host is asleep, so
  # this write is the invite link's — and it is filed as what happened.
  GLEGS="$BASE/api/invites/$GTOK/legs"
  check "the invite link may add a leg"            201 "${JSON[@]}" -X POST "$GLEGS" -d "{\"fromPlaceId\":\"$PID2\",\"toPlaceId\":\"$PID1\",\"mode\":\"walk\"}"
  GL=$(body "${JSON[@]}" -X POST "$GLEGS" -d "{\"fromPlaceId\":\"$PID2\",\"toPlaceId\":\"$PID1\",\"mode\":\"walk\",\"note\":\"missed the bus, walked it\"}")
  contains "...with no account anywhere in it"          "$GL" '"note":"missed the bus, walked it"'
  contains "...filed as what HAPPENED, not as the plan" "$GL" '"isPlanned":false'
  check "the map reads over the link as well"      200 "$BASE/api/invites/$GTOK/places"
  contains "...and carries the places by name"          "$(body "$BASE/api/invites/$GTOK/places")" '"name":"Hotel Bellevue"'
  # …but the guest PAGE is SSR'd from the invite payload, not from that route,
  # so the read the product actually performs is asserted too (#60: prove a
  # feature on the surface the product uses, not the one that is easiest to
  # curl). All three of these render on /i/<token>.
  INVPAGE=$(body "$BASE/api/invites/$GTOK")
  contains "the invite page carries the map it renders"  "$INVPAGE" '"places":[{'
  # The guest's OWN note, which no host leg in this fixture carries: a needle
  # any leg could satisfy would pass even if nothing a guest wrote ever reached
  # the payload.
  contains "...with the guest's own leg among them"      "$INVPAGE" '"note":"missed the bus, walked it"'
  contains "...and an item's pin beside its free text"   "$INVPAGE" '"location":"the front desk","placeId":"'
  # …and NOT the planning detail. The capability URL is forwardable and this
  # payload is the SSR'd page source of /i/<token>: a place's note is where a
  # host writes "lockbox 4417, back door", and no guest screen draws it or the
  # address. The coordinates stay — a pin's position is the point of it.
  excludes "the link carries no place's private note"    "$INVPAGE" 'lockbox 4417'
  excludes "...and no postal address either"             "$INVPAGE" 'Bahnhofplatz'
  contains "...while a pinned position still travels"    "$INVPAGE" '"lat":47.376887,"lng":8.541658'
  excludes "the refresh route narrows it the same way"   "$(body "$BASE/api/invites/$GTOK/places")" 'lockbox 4417'
  # Adding POINTS to the trip stays with the planners: the link says how you
  # travelled between the ones that are there.
  check "a place cannot be minted over the link"   404 "${JSON[@]}" -X POST "$BASE/api/invites/$GTOK/places" -d '{"name":"Mine now"}'
  check "...nor can one be removed"                404 "${JSON[@]}" -X DELETE "$BASE/api/invites/$GTOK/places/$PID1"

  # Everything `resolveInviteToken` carries besides identity, on this route too:
  # #48 lost exactly these by moving a write off the token.
  RINV=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG/invites" -d '{"label":"Revoked smoke"}')
  RTOK=$(printf '%s' "$RINV" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  RID=$(printf '%s' "$RINV" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
  check "a live link is what makes this work (control)" 201 "${JSON[@]}" -X POST "$BASE/api/invites/$RTOK/legs" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID3\",\"mode\":\"bike\"}"
  body "${AUTH[@]}" -X DELETE "$API/events/$GSLUG/invites/$RID" > /dev/null
  check "a REVOKED link cannot add one"            410 "${JSON[@]}" -X POST "$BASE/api/invites/$RTOK/legs" -d "{\"fromPlaceId\":\"$PID1\",\"toPlaceId\":\"$PID3\",\"mode\":\"bike\"}"

  # REMOVING A PLACE, which is the "defined way" #30 asks for. The counts below
  # are worked out from the fixture, not read back out of the answer: four legs
  # touch the hotel (the train in, the walk on, and the two the guest added),
  # every one of them still has its other end, and one itinerary item is pinned
  # to it. So four detached, none removed, one unpinned.
  DEL1=$(body "${PLN[@]}" -X DELETE "$HPLACES/$PID2")
  contains "removing a place says exactly what it touched" "$DEL1" '"removedLegs":0,"detachedLegs":4,"detachedItems":1'
  contains "...the legs survive it, half-joined"        "$DEL1" '"toPlaceId":null,"fromPlaceName":"Zug HB","toPlaceName":null'
  contains "...and the place itself is gone"            "$(leg_route "$(body "${PLN[@]}" "$HPLACES")")" "Zug HB>?"
  HOSTPAGE=$(body "${PLN[@]}" "$BASE/api/host/events/$GSLUG")
  contains "the pinned item falls back to its own text" "$HOSTPAGE" '"location":"the front desk","placeId":null'

  # …and the SECOND delete is the other half of the rule: the legs that lose
  # their last endpoint go with it rather than becoming a journey from nowhere
  # to nowhere. Three of them do (the train in and the guest's two walks); the
  # bus from Lakeside still has Lakeside, so it is detached instead.
  DEL2=$(body "${PLN[@]}" -X DELETE "$HPLACES/$PID1")
  contains "a leg that loses its LAST endpoint goes too" "$DEL2" '"removedLegs":3,"detachedLegs":3,"detachedItems":0'

  # The lifecycle rule, last, because it ends this trip: an invite link resolves
  # only on a live event, and a cancelled trip takes no writes at all.
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG/status" -d '{"status":"cancelled"}' > /dev/null
  # Lakeside and the Museum both survive the deletes above, so this is a leg
  # that WOULD be written if the lifecycle gate were not there. Sending one
  # place twice is refused by `insertLeg` whatever the event's status is, and
  # would prove nothing about the gate.
  check "a CANCELLED trip takes no leg from a guest" 403 "${JSON[@]}" -X POST "$GLEGS" -d "{\"fromPlaceId\":\"$PID3\",\"toPlaceId\":\"$PID4\",\"mode\":\"walk\"}"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

echo
echo "== searching for a place instead of typing its name (Bermos/zaeme#32) =="
# Typing latitudes by hand is not a feature anyone uses, so a planner searches
# and clicks. What is EXECUTED here is everything that is not decidable from the
# source: the credential (this route is the host session's and nothing else),
# the refusals, the normalisation end to end, and the uniqueness rule #30
# deferred and this issue answered — one OSM feature is one place per event,
# which is a partial unique index and therefore a statement Postgres runs.
#
# NOT ONE CHECK HERE DEPENDS ON NOMINATIM ANSWERING, and that is deliberate
# rather than timid: this suite runs in CI, from a runner whose address a public
# geocoder may decline to serve, and a red build that means "OpenStreetMap is
# busy" teaches everybody to ignore it. `geocode_shape` is what makes that
# honest — it validates the results when they arrive and the degrade envelope
# when they do not, and either way it fails on a zäme that answered rubbish.
# `test/geocode.test.ts` holds the cache policy, the rate limiter and the three
# failure modes, none of which touch the network either.
GEOTRIP32=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke search $SUFFIX\",\"type\":\"trip\"}")
GSLUG32=$(printf '%s' "$GEOTRIP32" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG32/status" -d '{"status":"published"}' > /dev/null
GTOK32=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$GSLUG32/invites" -d '{"label":"Search smoke"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
OTHER32=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke search elsewhere $SUFFIX\",\"type\":\"trip\"}")
OSLUG32=$(printf '%s' "$OTHER32" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
HSEARCH="$BASE/api/host/events/$GSLUG32/places/search"
HREVERSE="$BASE/api/host/events/$GSLUG32/places/reverse"
HPLACES32="$BASE/api/host/events/$GSLUG32/places"
echo "  trip: $GSLUG32"

check "a place search needs a session"            401 "$HSEARCH?q=lisbon"
check "...and a service token is not one"         401 "${AUTH[@]}" "$HSEARCH?q=lisbon"
check "naming a pin needs one too"                401 "$HREVERSE?lat=38.68944&lng=-9.17722"
# THE DECISION TAKEN AGAINST THE ISSUE'S WORDING, executed. #32 offers this to
# the invite capability URL as well; it is a link that gets forwarded into group
# chats, and a third-party proxy behind it hands everyone it reaches the ability
# to drive queries under this instance's identifying User-Agent — which is how
# an instance gets blocked, for an audience nobody can count. A guest cannot
# create a place either (#30), so there is nothing for them to do with a result.
check "the link cannot search for a place"        404 "$BASE/api/invites/$GTOK32/places/search?q=lisbon"
check "...nor name a pin over it"                 404 "$BASE/api/invites/$GTOK32/places/reverse?lat=38.7&lng=-9.1"
# And not on the machine API: a third-party dependency inside the contract
# Enterprise generates its tools from is a verb nobody decided to hand the model.
check "the geocoder is not on the machine API"    404 "${AUTH[@]}" "$API/events/$GSLUG32/places/search?q=lisbon"

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  PLN32=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")

  # THE REFUSALS. 400 is the zod schema (there was no query at all); 422 is the
  # domain having read it. "Type more" is deliberately NOT an empty result list:
  # an empty list means "there is no such place", which is a different sentence.
  check "a search with no query at all"           400 "${PLN32[@]}" "$HSEARCH"
  check "a one-character search"                  422 "${PLN32[@]}" "$HSEARCH?q=z"
  contains "...and says to type more"                  "$(body "${PLN32[@]}" "$HSEARCH?q=z")" 'Type at least 2 characters'
  # The OPPOSITE advice, and it used to be the same sentence: 161 characters is
  # past what the domain will key, and "type at least 2 characters" is the one
  # thing that cannot help whoever pasted a paragraph into the box.
  LONG32=$(printf 'x%.0s' $(seq 1 170))
  check "a search longer than a place name"       422 "${PLN32[@]}" --get --data-urlencode "q=$LONG32" "$HSEARCH"
  contains "...and says to shorten it instead"         "$(body "${PLN32[@]}" --get --data-urlencode "q=$LONG32" "$HSEARCH")" 'at most 160 characters'
  check "a pin that is not on the planet"         422 "${PLN32[@]}" "$HREVERSE?lat=91&lng=0"
  check "half a pin"                              422 "${PLN32[@]}" "$HREVERSE?lat=38.68944&lng="
  contains "...says both or neither, like a place"     "$(body "${PLN32[@]}" "$HREVERSE?lat=38.68944&lng=")" 'both a latitude and a longitude'

  # THE ACCEPTANCE CRITERION'S OWN QUERY. What is asserted of it unconditionally
  # is the shape and the NORMALISATION — "  Ponte  25 DE Abril " and "ponte 25
  # de abril" are one question, and the echoed query is what proves the folding
  # ran on the way to the cache key rather than only in a unit test.
  S1=$(body "${PLN32[@]}" "$HSEARCH?q=%20%20Ponte%20%2025%20DE%20Abril%20")
  check "a place search always answers"           200 "${PLN32[@]}" "$HSEARCH?q=Ponte+25+de+Abril"
  equals "...in one of the two shapes it promises" "$(geocode_shape "$S1")" "well-formed"
  contains "...echoing the query as it was keyed"      "$S1" '"query":"ponte 25 de abril"'
  contains "...naming the geocoder that answered"      "$S1" '"provider":"nominatim"'
  contains "...and the attribution OSM data needs"     "$S1" 'OpenStreetMap contributors'

  # THE CACHE, on a query NOTHING has ever asked — this suite re-runs against
  # the database the last run left behind, and "Ponte 25 de Abril" may well be
  # in the cache table already, which would make a `"cached":false` assertion on
  # it pass exactly once per Postgres.
  NEW32="smoke nowhere $SUFFIX"
  C1=$(body "${PLN32[@]}" --get --data-urlencode "q=$NEW32" "$HSEARCH")
  C2=$(body "${PLN32[@]}" --get --data-urlencode "q=$NEW32" "$HSEARCH")
  ST1=$(printf '%s' "$C1" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  CACHED1=$(printf '%s' "$C1" | sed -n 's/.*"cached":\([a-z]*\).*/\1/p')
  CACHED2=$(printf '%s' "$C2" | sed -n 's/.*"cached":\([a-z]*\).*/\1/p')
  equals "a question never asked is not a cache hit" "$CACHED1" "false"
  # A SUCCESSFUL answer is kept and a FAILED one never is, which is the same
  # rule read from either side: caching "we could not ask" would turn a
  # thirty-second outage into a thirty-day one. Written as a derived
  # expectation rather than a conditional, so this check runs — and can fail —
  # whether or not the geocoder was reachable from wherever this is running.
  if [ "$ST1" = "ok" ]; then WANT32=true; else WANT32=false; fi
  equals "...and is answered from the cache next time" "$CACHED2" "$WANT32"

  # REVERSE. The key is the pin ROUNDED to about a metre, and the same point
  # typed to seven decimals is the same question — otherwise every pin is its
  # own cache row and the cache never hits at all.
  R1=$(body "${PLN32[@]}" "$HREVERSE?lat=38.68944&lng=-9.17722")
  check "a dropped pin can be named"              200 "${PLN32[@]}" "$HREVERSE?lat=38.68944&lng=-9.17722"
  equals "...in one of the two shapes as well"    "$(geocode_shape "$R1")" "well-formed"
  contains "...keyed on the pin, not on a name"        "$R1" '"query":"38.68944,-9.17722"'
  contains "...and a finer pin is the same question"   "$(body "${PLN32[@]}" "$HREVERSE?lat=38.6894441&lng=-9.1772221")" '"query":"38.68944,-9.17722"'

  # THREE PLANNERS AT ONCE. The rate limiter is a queue in one process, so the
  # thing worth executing is that it neither deadlocks nor 500s when three
  # requests are genuinely in flight together — which no unit test with a fake
  # clock can say anything about.
  BURST32=$(mktemp -d)
  for n in 1 2 3; do
    curl -s -o /dev/null -w '%{http_code}' "${PLN32[@]}" --get \
      --data-urlencode "q=smoke burst $n $SUFFIX" "$HSEARCH" > "$BURST32/$n" &
  done
  wait
  equals "three searches at once all answer"      "$(cat "$BURST32/1" "$BURST32/2" "$BURST32/3" | tr -d '\n')" "200200200"
  rm -rf "$BURST32"

  # ONE OSM FEATURE IS ONE PLACE PER EVENT — #30 left this open and #32 closed
  # it. The rule is a PARTIAL unique index (`where osm_id is not null`), so both
  # halves need executing: the same feature twice is refused, and hand-typed
  # places with no reference at all are not touched by it however many there are.
  BRIDGE32='"lat":"38.689444","lng":"-9.177222","osmType":"way","osmId":"4306103"'
  MATCHED=$(body "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d "{\"name\":\"Ponte 25 de Abril\",$BRIDGE32}")
  contains "a searched place records what it matched"  "$MATCHED" '"osmType":"way","osmId":"4306103"'
  contains "...with the coordinates it came back with" "$MATCHED" '"lat":38.689444,"lng":-9.177222'
  check "the same feature twice is refused"       409 "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d "{\"name\":\"The bridge again\",$BRIDGE32}"
  contains "...naming the place already there"         "$(body "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d "{\"name\":\"The bridge again\",$BRIDGE32}")" 'Ponte 25 de Abril is already on this trip'
  check "half an OSM reference is refused"        422 "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d '{"name":"Half a reference","osmId":"4306103"}'
  contains "...and says both or neither"               "$(body "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d '{"name":"Half a reference","osmId":"4306103"}')" 'both an OpenStreetMap type and id'
  # The other half of the rule, executed: two hand-typed places with no
  # reference at all are not duplicates of each other. That is the ordinary case
  # and the one a uniqueness rule is most likely to break — a domain check that
  # forgot to return early on a null reference refuses the second of these.
  check "a hand-typed place needs no reference"   201 "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d '{"name":"Ana flat"}'
  check "...and a second one is not a duplicate"  201 "${PLN32[@]}" "${JSON[@]}" -X POST "$HPLACES32" -d '{"name":"The usual spot"}'
  # The rule is PER EVENT: another trip may pin the same bridge.
  check "another trip may match the same feature" 201 "${PLN32[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$OSLUG32/places" -d "{\"name\":\"Ponte 25 de Abril\",$BRIDGE32}"
  # …and an EDIT is the second writer of that pair, which is the half a rule
  # applied only on the add would leave open.
  FLAT32=$(place_id "$(body "${PLN32[@]}" "$HPLACES32")" "Ana flat")
  check "an edit cannot take another place's feature" 409 "${PLN32[@]}" "${JSON[@]}" -X PATCH "$HPLACES32/$FLAT32" -d "{$BRIDGE32}"
  # …AND A PLACE IS NOT A DUPLICATE OF ITSELF. The self-exclusion in
  # `assertOsmRefFree` is the one line that makes the edit branch usable at all,
  # and nothing else here can see it: replacing the `find` with `rows[0]` leaves
  # every other check in this suite and every unit test green, while every save
  # of a geocoded place 409s against itself.
  BRIDGEID32=$(place_id "$(body "${PLN32[@]}" "$HPLACES32")" "Ponte 25 de Abril")
  check "a geocoded place may be saved again"     200 "${PLN32[@]}" "${JSON[@]}" -X PATCH "$HPLACES32/$BRIDGEID32" -d "{\"name\":\"Ponte 25 de Abril\",$BRIDGE32}"
  contains "...and still holds the feature after"      "$(body "${PLN32[@]}" "$HPLACES32")" '"osmType":"way","osmId":"4306103"'
  check "...while a place keeps its own on a rename" 200 "${PLN32[@]}" "${JSON[@]}" -X PATCH "$HPLACES32/$FLAT32" -d '{"name":"Ana upstairs flat"}'
  KEPT=$(body "${PLN32[@]}" "$HPLACES32")
  contains "the renamed place is still on the trip"    "$KEPT" '"name":"Ana upstairs flat"'
  # A PLACE WITH NO COORDINATES STAYS A FIRST-CLASS STATE (#30): nothing in this
  # issue is on the path of adding one, and the form works with the geocoder
  # unreachable because that is still the only way a place is written.
  contains "...and still has no coordinates at all"    "$KEPT" '"name":"Ana upstairs flat","address":null,"lat":null,"lng":null'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
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
