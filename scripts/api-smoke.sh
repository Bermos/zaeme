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

# `bring_state <body> <title>` — the whole state of one bring-list item as a
# single string: `needed/claimed/remaining/done-or-open/who`, e.g.
# `6/4/2/open/ada@example.com` and `none/1/none/done/ada@example.com` for an
# item that never stated a count.
#
# A `contains` CANNOT DO THIS (#44), for two reasons. The first is arithmetic:
# "4 claimed, 2 to go" is a relationship between three numbers, and a needle on
# any one of them passes on a list that has the other two wrong. The second is
# that this is a LIST — a needle matches the payload, not the item, so
# `'"quantityRemaining":2'` is satisfied by any other item on the event that
# happens to have two to go.
#
# `none` and not `0` for a missing count, deliberately: the acceptance criterion
# is that an item with no stated need behaves as it always did, and the wrong
# implementation of that — treat a missing need as a need of zero — produces
# `0/0/0/done` where the right one produces `none/0/none/open`. The two must not
# print the same string. Sentinels (`unparseable`, `no-such-item`) rather than
# an empty answer, so a dead server does not read as a clean bill of health.
bring_state() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      // /api/v1 answers a bare array, the human surfaces wrap it, and a write
      // answers the single item it touched.
      const list = Array.isArray(b) ? b : (b.contributions ?? (b.contribution ? [b.contribution] : []))
      const item = list.find(x => x && x.title === process.argv[1])
      if (!item) return process.stdout.write("no-such-item")
      const n = v => (v === null || v === undefined ? "none" : String(v))
      const who = (item.claims ?? []).map(c => c.email).sort().join(",")
      process.stdout.write([
        n(item.quantityNeeded),
        n(item.quantityClaimed),
        n(item.quantityRemaining),
        item.claimed ? "done" : "open",
        who || "nobody"
      ].join("/"))
    })' "$2"
}

# `bring_id <body> <title>` — the id of the named bring-list item. A `sed` over
# adjacent JSON keys would do it today and would silently start matching the
# wrong thing the day a field is inserted between them; `no-such-item` rather
# than an empty string, which would turn `…/contributions//claim` into a 404
# that has nothing to do with what is being tested.
bring_id() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = Array.isArray(b) ? b : (b.contributions ?? (b.contribution ? [b.contribution] : []))
      process.stdout.write(list.find(x => x && x.title === process.argv[1])?.id ?? "no-such-item")
    })' "$2"
}

# `bring_copies <body> <title>` — HOW MANY items on the list carry that title
# (#45). `bring_state` cannot answer this: it finds the FIRST match, so a list
# holding two Wines reads exactly like a list holding one, and "applying twice
# does not duplicate" is the acceptance criterion that failure mode is aimed at.
# `unparseable` rather than `0`, so a dead server does not read as a clean list.
bring_copies() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = Array.isArray(b) ? b : (b.contributions ?? (b.contribution ? [b.contribution] : []))
      process.stdout.write(String(list.filter(x => x && x.title === process.argv[1]).length))
    })' "$2"
}

# `suggest_state <body>` — the whole envelope of a bring-list SUGGESTION as one
# string: `source/headcount/itemCount/reason-or-none` (#45), e.g.
# `static/12/6/none` for a party of twelve and `static/0/0/reason` for a gig.
#
# One `equals` rather than four `contains`, for the reason `bring_state` exists:
# a needle on `"headcount":12` says nothing about whether any item was scaled by
# it, and a needle on `"reason":` is satisfied by `"reason":null`. The fourth
# field is the rule the whole feature rests on — ITEMS OR A REASON, NEVER
# NEITHER — so `0/none` is the shape of a dead control and no type may print it.
suggest_state() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const g = b.suggestion
      if (!g) return process.stdout.write("no-suggestion")
      process.stdout.write([
        g.source,
        g.headcount,
        (g.items ?? []).length,
        g.reason ? "reason" : "none"
      ].join("/"))
    })'
}

# `source_items <body> <slug>` — how many bring-list items the named event
# offers to be copied from, or `no-such-source` when it is not offered at all
# (#45). A `contains` on `"itemCount":2` is satisfied by ANY source with two
# items, which on a re-run is every previous run's fixture; this ties the number
# to the event whose number is being asserted, and answers the negative half —
# "an upcoming party is not one you have run" — with a string that cannot also
# mean "the list came back empty".
source_items() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const hit = (b.sources ?? []).find(x => x && x.slug === process.argv[1])
      process.stdout.write(hit ? String(hit.itemCount) : "no-such-source")
    })' "$2"
}

# `suggest_body <body>` — a preview turned into the POST body that applies it,
# VERBATIM (#45). The copy check applies what the server actually offered rather
# than a hand-written stand-in, and the difference is the whole point: a
# hand-written body cannot carry a field the preview should never have had, so
# "the copy brings the claims across" would leave it green while the claims
# rode through. Anything the preview leaks is posted here, and whether it lands
# is then the schema's answer and the domain's, asserted afterwards.
suggest_body() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("{\"items\":[]}") }
      process.stdout.write(JSON.stringify({ items: b.suggestion?.items ?? [] }))
    })'
}

# `suggest_count <body> <title>` — the count proposed for one named line of a
# suggestion. `none` for a line that proposes no count at all (a copied
# free-text item), which must not print the same string as a count of zero.
suggest_count() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const item = (b.suggestion?.items ?? []).find(x => x && x.title === process.argv[1])
      if (!item) return process.stdout.write("no-such-item")
      process.stdout.write(item.quantityNeeded === null || item.quantityNeeded === undefined
        ? "none"
        : String(item.quantityNeeded))
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

# THE RECEIPT HELPERS (#29). A receipt is a nested object on an entry, and the
# two questions worth asking about one are not answerable with `sed`: what the
# signed URL is (so the bytes can be fetched back and hashed), and whether the
# MONEY on that entry moved when the photo was pinned.

# `receipt_of <body> <title> <field>` — one field of the named entry's receipt,
# or a word saying which thing was missing. `none` and `no-such-entry` are
# different answers on purpose: "the pin did not take" and "the expense is not
# there" must not both read as an empty string.
receipt_of() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      if (!e) return process.stdout.write("no-such-entry")
      if (!e.receipt) return process.stdout.write("none")
      const v = e.receipt[process.argv[2]]
      process.stdout.write(v === undefined || v === null ? "unset" : String(v))
    })' "$2" "$3"
}

# `money_of <body> <title>` — every figure and label the entry states about its
# own money, as one string.
#
# It exists so "pinning a receipt relabels nothing" can be asserted WITHOUT
# writing the expected values down. A literal there would be a constant standing
# in for "unchanged" — true only while the fixture happens to make it so, and
# silently satisfied by an implementation that rewrote a row to the same
# defaults. Comparing this against the SAME function run on the response from
# before the pin is the only form of the assertion that cannot pass by accident.
money_of() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const budget = b.budget ?? b
      const e = (budget.expenses ?? [budget]).find(x => x.title === process.argv[1])
      if (!e) return process.stdout.write("no-such-entry")
      process.stdout.write([
        e.amountCents, e.currency, e.amountBaseCents, e.baseCurrency,
        e.fxRate, e.fxRateSource, e.statedAmountCents, e.statedCurrency,
        (e.shares ?? []).map(sh => sh.amountCents).join("/")
      ].join(" "))
    })' "$2"
}

# `media_field <body> <mediaId> <field>` — one field of one item in a
# `/api/v1` listMedia array, for reading `expenseId` back off the machine
# surface.
media_field() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let items
      try { items = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = Array.isArray(items) ? items : (items.media ?? items.gallery ?? [])
      const m = list.find(x => x.id === process.argv[1])
      if (!m) return process.stdout.write("no-such-item")
      const v = m[process.argv[2]]
      process.stdout.write(v === undefined || v === null ? "null" : String(v))
    })' "$2" "$3"
}

# `ticket_field <body> <mediaId> <field>` — one field of the TICKET DETAIL on
# one media item (#35), and the three ways it can be absent are three DIFFERENT
# answers, which is the whole point of the helper:
#
#   no-such-item   the viewer cannot see that media row at all
#   no-detail      the row is there and `ticket` is null — nobody has written
#                  anything on it, which is every ticket from before #35
#   null           there IS a detail row and this field of it is blank
#
# A helper that folded the last two together could not tell "no detail row" from
# "a detail row somebody cleared", which is exactly the distinction the issue
# turns on: an entirely empty detail is legal and must survive.
ticket_field() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let items
      try { items = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const raw = Array.isArray(items) ? items : (items.media ?? items.tickets ?? [])
      // A write answers with ONE item under `media`; a list answers an array.
      const list = Array.isArray(raw) ? raw : [raw]
      const m = list.find(x => x && x.id === process.argv[1])
      if (!m) return process.stdout.write("no-such-item")
      if (m.ticket === undefined || m.ticket === null) return process.stdout.write("no-detail")
      const v = m.ticket[process.argv[2]]
      process.stdout.write(v === undefined || v === null ? "null" : String(v))
    })' "$2" "$3"
}

# `ticket_assignees <body> <mediaId>` — who one ticket is for (#36), as a
# SORTED comma-joined list of RSVP ids, and four DIFFERENT answers for the four
# different things that can be true:
#
#   no-such-item   the viewer cannot see that media row at all
#   no-field       the row is there and carries no `assignedRsvpIds` AT ALL
#   none           the field is there and empty — nobody has this ticket
#   a,b,c          the ids, sorted, so the assertion does not depend on the
#                  order a list happened to come back in
#
# `no-field` AND `none` ARE KEPT APART BECAUSE THEY ARE DIFFERENT FAILURES, and
# WHICH of them a broken read produces depends on the surface — which is worth
# knowing before leaning on either.
#
# On the host and invite surfaces the domain view goes out as it is, so a read
# that stopped carrying the field drops the key and this answers `no-field`. On
# `/api/v1` it cannot: `server/utils/v1-shapes.ts` normalises a missing field to
# `[]` (the contract says the field is always present), so the same bug arrives
# there as `none` — a ticket that reads as nobody's. That is the #78 shape, and
# `listMedia` has shipped it twice already (#29's `expenseId`, #35's `ticket`).
#
# SO EVERY ASSERTION BELOW NAMES THE IDS IT EXPECTS rather than settling for
# "not empty". Measured: removing `assignedRsvpIds` from the `/api/v1` feeder
# reddens 8 of these — every one of them an equality against a non-empty list —
# and not one of them is the `no-field` line, because on that surface there is
# no such answer to give.
ticket_assignees() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let items
      try { items = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const raw = Array.isArray(items) ? items : (items.media ?? items.tickets ?? [])
      // A write answers with ONE item under `media`; a list answers an array.
      const list = Array.isArray(raw) ? raw : [raw]
      const m = list.find(x => x && x.id === process.argv[1])
      if (!m) return process.stdout.write("no-such-item")
      if (!Object.hasOwn(m, "assignedRsvpIds")) return process.stdout.write("no-field")
      const ids = m.assignedRsvpIds
      if (!Array.isArray(ids)) return process.stdout.write("not-a-list")
      process.stdout.write(ids.length === 0 ? "none" : [...ids].sort().join(","))
    })' "$2"
}

# `guest_field <body> <bucket> <mediaId> <field>` — one field of one item in one
# BUCKET of the invite link's media answer (#37), and the absences are kept
# apart for the reason `ticket_field` keeps its three apart:
#
#   no-such-item   that bucket does not carry that media row at all
#   no-field       the row is there and the field is not — the #78 shape, and
#                  what a read that stopped projecting `mine` looks like
#   null           the field is there and is null
#   true / false   the value, as JSON spells it
#
# `no-field` IS THE ONE THAT EARNS THE HELPER. `mine: false` and "this surface
# forgot to compute `mine`" are the same thing to any check that asks "is it
# false?", and they are opposite findings: the first says the viewer is not on
# the ticket, the second says nobody is ever on any ticket again. The invite
# surface sends the domain view out as it is, so a dropped field drops the key.
guest_field() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = b[process.argv[1]]
      if (!Array.isArray(list)) return process.stdout.write("no-such-bucket")
      const m = list.find(x => x && x.id === process.argv[2])
      if (!m) return process.stdout.write("no-such-item")
      if (!Object.hasOwn(m, process.argv[3])) return process.stdout.write("no-field")
      const v = m[process.argv[3]]
      process.stdout.write(v === null ? "null" : String(v))
    })' "$2" "$3" "$4"
}

# `guest_bucket <body> <bucket>` — the SORTED ids in one bucket of the invite
# link's media answer, comma-joined, or `none` when the bucket is empty.
#
# This is the helper that measures the widening itself (#37): "which tickets did
# this viewer get" is a set, and a `contains` on one filename cannot tell a list
# of two from a list of one that happens to include it.
guest_bucket() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = b[process.argv[1]]
      if (!Array.isArray(list)) return process.stdout.write("no-such-bucket")
      const ids = list.map(x => x && x.id).filter(Boolean).sort()
      process.stdout.write(ids.length === 0 ? "none" : ids.join(","))
    })' "$2"
}

# `ticket_names <body> <mediaId>` — who a ticket is FOR, BY NAME (#37), sorted
# and comma-joined, with the same four answers `ticket_assignees` gives:
#
#   no-such-item / no-field / none / Ana,Ben
#
# A SECOND HELPER RATHER THAN A FLAG ON THE FIRST, because the two answer
# different questions and the #37 screen needs both: `assignedRsvpIds` is who it
# is for, and `assignedTo` is what the guest page can actually PRINT — the
# invite page's `attendees` list carries names and no RSVP ids at all, so an id
# alone would render as a cuid2. Asserting them against each other is how the
# two stay one answer rather than two.
ticket_names() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const raw = Array.isArray(b) ? b : (b.tickets ?? b.media ?? [])
      const list = Array.isArray(raw) ? raw : [raw]
      const m = list.find(x => x && x.id === process.argv[1])
      if (!m) return process.stdout.write("no-such-item")
      if (!Object.hasOwn(m, "assignedTo")) return process.stdout.write("no-field")
      const who = m.assignedTo
      if (!Array.isArray(who)) return process.stdout.write("not-a-list")
      const names = who.map(a => (a && a.name) ?? "?").sort()
      process.stdout.write(names.length === 0 ? "none" : names.join(","))
    })' "$2"
}

# `pinned_step <body> <mediaId>` — WHICH STEP OF THE PLAN one media item is
# pinned to (#38), and the three absences are kept apart for the reason
# `ticket_field` keeps its three apart:
#
#   no-such-item   that surface does not carry that media row at all
#   no-field       the row is there and `timelineItemId` is not — THE #78 SHAPE,
#                  and exactly the bug this issue is about: the column has been
#                  on the row since the transplant and on `/api/v1` since that
#                  surface existed, and the two reads a PERSON looks at dropped
#                  it before it reached a screen
#   null           the field is there and this file is pinned to nothing
#   <id>           the step
#
# `no-field` IS WHAT EARNS THE HELPER, and `media_field` beside it cannot give
# it: that one prints `null` for a missing key AND for a null value, so "nothing
# is pinned here" and "this surface stopped carrying the pin" would be the same
# green tick — which is the entire defect wearing a passing check.
pinned_step() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const raw = Array.isArray(b)
        ? b
        : [...(b.media ? (Array.isArray(b.media) ? b.media : [b.media]) : []),
           ...(b.tickets ?? []), ...(b.documents ?? []), ...(b.gallery ?? [])]
      const m = raw.find(x => x && x.id === process.argv[1])
      if (!m) return process.stdout.write("no-such-item")
      if (!Object.hasOwn(m, "timelineItemId")) return process.stdout.write("no-field")
      process.stdout.write(m.timelineItemId === null ? "null" : String(m.timelineItemId))
    })' "$2"
}

# `pinned_ids <body> <timelineItemId>` — the SORTED media ids pinned to one step,
# comma-joined, or `none` when nothing is.
#
# A SET, NOT A `contains`, for the reason `guest_bucket` is one: "the ticket is
# on the 09:14" is satisfied by a step that shows every file on the trip, and
# "the 11:40 has nothing" is satisfied by a read that lost the field entirely.
# Comparing the whole set at each step is what tells a pin from a smear, and a
# MOVE — the pin leaving one step as it arrives at the other — is two set
# assertions that no single `contains` can make.
#
# It reads every bucket the invite link answers AND a host `{media: [...]}` list,
# so the same expectation can be made against both surfaces; and it ignores an
# item with no `timelineItemId` key at all, which `pinned_step` above is the
# thing that catches.
pinned_ids() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const raw = Array.isArray(b)
        ? b
        : [...(b.media ? (Array.isArray(b.media) ? b.media : [b.media]) : []),
           ...(b.tickets ?? []), ...(b.documents ?? []), ...(b.gallery ?? [])]
      const ids = raw.filter(x => x && x.timelineItemId === process.argv[1]).map(x => x.id).sort()
      process.stdout.write(ids.length === 0 ? "none" : ids.join(","))
    })' "$2"
}

# `sorted_ids <id>...` — the same sort `ticket_assignees` applies, so an
# expectation is built from the ids a test minted rather than typed out in
# whatever order they were created in.
sorted_ids() {
  printf '%s\n' "$@" | LC_ALL=C sort | paste -sd, -
}

# `rsvp_id <body> <email>` — the id of the RSVP with that address, from a
# `{rsvps:…}` body. Matched on the ADDRESS rather than on "the first one": by
# the time a ticket is assigned the trip has more than one attendee, and
# assigning it to the wrong person reads exactly like the feature being broken.
rsvp_id() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const r = (b.rsvps ?? []).find(x => (x.guestEmail ?? "").toLowerCase() === process.argv[1].toLowerCase())
      process.stdout.write(r ? r.id : "no-such-rsvp")
    })' "$2"
}

# `json_field <body> <dotted-path>` — a scalar out of a small response, for the
# two-step upload's `mediaId` and presigned URL. `sed` cannot be trusted with
# the second: it is a URL full of `&`, `=` and `/`.
json_field() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      let v = b
      for (const key of process.argv[1].split(".")) v = v?.[key]
      process.stdout.write(v === undefined || v === null ? "" : String(v))
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
# `tl_start <body> <title>` — the RAW instant one itinerary item is stored at
# (#31), out of a `/api/v1` timeline array or out of any aggregate carrying a
# `timeline`.
#
# A `grep -o` over `"startsAt":"…"` would have done it in one line and would
# have been the wrong tool: an aggregate carries an event's own start, a poll
# option's and a timeline item's under that same key, so the regex matches its
# SIBLINGS and the answer depends on which surface is read. Naming the item is
# what makes "this instant did not move" a statement about one row. Sentinels
# rather than an empty string, for the usual reason: two empty strings compare
# equal, so a dead server would read as proof that nothing changed.
tl_start() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const list = Array.isArray(b) ? b : (b.timeline ?? [])
      if (!Array.isArray(list)) return process.stdout.write("no-timeline")
      const item = list.find(x => x.title === process.argv[1])
      if (!item) return process.stdout.write("no-such-item")
      process.stdout.write(item.startsAt == null ? "null" : String(item.startsAt))
    })' "$2"
}

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

# `geocode_zones <body>` (#31 over #32) — whether the zone suggestion is honest.
#
# Same discipline as `geocode_shape` above, and the same reason: a geocoder is
# somebody else's server, so this is a verdict about the RULE rather than an
# expectation of a particular place. The rule is that every result carries a
# `timeZones` array, and that a result which names a country carries at least
# one zone in it — ICU knows the zones of every country there is, so an empty
# list beside a country code means the derivation was dropped rather than that
# the country has no clocks. A result with no country (a pin in the sea, a row
# cached before `addressdetails` was asked for) offers nothing, which is
# correct and is not a fault.
#
# `well-zoned` is therefore also the right answer for an EMPTY result list and
# for the unavailable envelope: there is nothing to suggest and nothing wrong.
# `zone_count <body>` (#31) — how many zones the first result offers, or a
# sentinel. The point of the number is that it is NOT four: the offer used to be
# `.slice(0, 4)` and a `contains` on any single zone name passes either way.
zone_count() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      const first = (b.results ?? [])[0]
      if (!first) return process.stdout.write("no-results")
      if (!Array.isArray(first.timeZones)) return process.stdout.write("no-zone-list")
      process.stdout.write(String(first.timeZones.length))
    })'
}

geocode_zones() {
  printf '%s' "$1" | node -e '
    let s = ""
    process.stdin.on("data", d => s += d).on("end", () => {
      let b
      try { b = JSON.parse(s) } catch { return process.stdout.write("unparseable") }
      if (!Array.isArray(b.results)) return process.stdout.write("no-results-array")
      for (const r of b.results) {
        if (!Array.isArray(r.timeZones)) return process.stdout.write("result-with-no-zone-list")
        if (r.countryCode && r.timeZones.length === 0) return process.stdout.write("country-without-zones")
        for (const z of r.timeZones) {
          if (typeof z !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_+-]+)+$/.test(z) || /^Etc\//.test(z)) {
            return process.stdout.write("zone-that-is-not-a-region-name")
          }
        }
      }
      process.stdout.write("well-zoned")
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
echo "== the bring list counts (Bermos/zaeme#44) =="
# WHAT THESE PROVE THAT NOTHING ELSE CAN. `pnpm test` runs no SQL, so the new
# `events_contribution_claim` table, its unique `(contribution_id, email)` and
# the `for update` that serialises two people claiming the last bottle are
# proved here or nowhere. The three acceptance criteria are each one `equals`
# over `bring_state`, which is arithmetic a needle cannot do.
#
# IT MINTS ITS OWN EVENT, because this suite re-runs against the rows the last
# run left behind. An invite link only resolves on a LIVE event, so it publishes
# first — a draft 403s for a reason that has nothing to do with bring lists.
BL=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
  -d "{\"title\":\"Smoke potluck $SUFFIX\",\"type\":\"hosted\",\"startsAt\":\"2027-05-01T18:00:00+02:00\"}")
BLSLUG=$(printf '%s' "$BL" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$BLSLUG/status" -d '{"status":"published"}' > /dev/null
BLTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$BLSLUG/invites" -d '{"label":"Potluck smoke"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
BLI="$BASE/api/invites/$BLTOK/contributions"
BLV="$API/events/$BLSLUG/contributions"
echo "  potluck: $BLSLUG"

# ---- an item that says how many are wanted ----
check "addPotluckItem takes a count"             201 "${AUTH[@]}" "${JSON[@]}" -X POST "$BLV" \
  -d '{"title":"Bottles","category":"drink","quantityNeeded":6,"unit":"bottles"}'
equals "...and six are wanted, none claimed"     "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/0/6/open/nobody"

BLID=$(bring_id "$(body "${AUTH[@]}" "$BLV")" 'Bottles')
check "a guest claims three of the six"          200 "${JSON[@]}" -X POST "$BLI/$BLID/claim" \
  -d '{"guestName":"Ada","guestEmail":"ada-44@example.com","quantity":3}'
equals "...and three are still to go"            "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/3/3/open/ada-44@example.com"

check "a SECOND guest claims the other three"    200 "${JSON[@]}" -X POST "$BLI/$BLID/claim" \
  -d '{"guestName":"Bo","guestEmail":"bo-44@example.com","quantity":3}'
equals "...which closes it — two people, one item" "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/6/0/done/ada-44@example.com,bo-44@example.com"
check "a third cannot claim what is spoken for"  409 "${JSON[@]}" -X POST "$BLI/$BLID/claim" \
  -d '{"guestName":"Cy","guestEmail":"cy-44@example.com","quantity":1}'

check "Bo releases their claim"                  200 "${JSON[@]}" -X POST "$BLI/$BLID/release" \
  -d '{"guestEmail":"bo-44@example.com"}'
equals "...and it reopens with the RIGHT remainder" "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/3/3/open/ada-44@example.com"

check "Ada raises her own claim to all six"      200 "${JSON[@]}" -X POST "$BLI/$BLID/claim" \
  -d '{"guestName":"Ada","guestEmail":"ada-44@example.com","quantity":6}'
equals "...adjusting her row, not adding a second" "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/6/0/done/ada-44@example.com"

# THE ONE BRANCH `claimContribution` KEEPS FOR A FINISHED ITEM, walked. Every
# claim above was made while the item still had room, so the refusal's second
# half — "…and the caller holds no claim on it" — was the only part exercised.
# Lowering your own number on a DONE item is the sole way to re-open one without
# releasing it outright, which would tell the party nobody is bringing the thing
# for as long as it takes to claim again. `BringList.vue`'s `canAdjust` is what
# offers it; without these two the domain comment describing it is a claim no
# check can falsify.
check "Ada can lower her own claim on a FULL item" 200 "${JSON[@]}" -X POST "$BLI/$BLID/claim" \
  -d '{"guestName":"Ada","guestEmail":"ada-44@example.com","quantity":3}'
equals "...which re-opens it at the right remainder" "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Bottles')" "6/3/3/open/ada-44@example.com"

# ---- an item with NO count, which must behave exactly as it did before #44 ----
check "an item with no count at all"             201 "${AUTH[@]}" "${JSON[@]}" -X POST "$BLV" -d '{"title":"Crisps"}'
equals "...is unclaimed and has no remainder"    "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Crisps')" "none/0/none/open/nobody"
CRID=$(bring_id "$(body "${AUTH[@]}" "$BLV")" 'Crisps')
check "one guest says they'll bring it"          200 "${JSON[@]}" -X POST "$BLI/$CRID/claim" \
  -d '{"guestName":"Ada","guestEmail":"ada-44@example.com"}'
equals "...and that alone finishes it, as before" "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Crisps')" "none/1/none/done/ada-44@example.com"
check "a second guest is refused, as before"     409 "${JSON[@]}" -X POST "$BLI/$CRID/claim" \
  -d '{"guestName":"Bo","guestEmail":"bo-44@example.com"}'
check "the claimer releases it"                  200 "${JSON[@]}" -X POST "$BLI/$CRID/release" \
  -d '{"guestEmail":"ada-44@example.com"}'
equals "...and it is on offer again"             "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Crisps')" "none/0/none/open/nobody"

# ---- bringing more than was asked for is a party, not an error ----
check "two trays wanted"                         201 "${AUTH[@]}" "${JSON[@]}" -X POST "$BLV" \
  -d '{"title":"Lasagne","category":"food","quantityNeeded":2,"unit":"trays"}'
LAID=$(bring_id "$(body "${AUTH[@]}" "$BLV")" 'Lasagne')
check "somebody brings ten"                      200 "${JSON[@]}" -X POST "$BLI/$LAID/claim" \
  -d '{"guestName":"Cy","guestEmail":"cy-44@example.com","quantity":10}'
equals "...and the remainder floors at zero"     "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Lasagne')" "2/10/0/done/cy-44@example.com"

# ---- a guest stating a count IS bringing that many ----
check "a guest adds six buns over the link"      200 "${JSON[@]}" -X POST "$BLI" \
  -d '{"title":"Buns","category":"food","quantityNeeded":6,"unit":"buns","guestName":"Dee","guestEmail":"dee-44@example.com"}'
equals "...and is bringing all six of them"      "$(bring_state "$(body "${AUTH[@]}" "$BLV")" 'Buns')" "6/6/0/done/dee-44@example.com"

# ---- the refusals, and the shape Enterprise now sees ----
check "a claim of zero is refused"               400 "${JSON[@]}" -X POST "$BLI/$LAID/claim" \
  -d '{"guestName":"Cy","guestEmail":"cy-44@example.com","quantity":0}'
check "a count of zero is refused"               422 "${AUTH[@]}" "${JSON[@]}" -X POST "$BLV" \
  -d '{"title":"Nothing","quantityNeeded":0}'
# THE BREAKING CHANGE, asserted on the wire. Enterprise generates its client
# from the contract and the contract test's bijection is over paths and methods,
# so nothing else in this repository would notice these three coming back.
POT=$(body "${AUTH[@]}" "$BLV")
excludes "listPotluck no longer names one claimer" "$POT" '"claimedByEmail"'
excludes "...nor their name"                       "$POT" '"claimedByName"'
contains "...it answers a list of claims instead"  "$POT" '"claims":['

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  # THE SURFACE A PLANNER IS ACTUALLY ON. Seeding a count is the host's gesture
  # and claiming is the guest's; a host add that claimed would make every item a
  # planner typed read as already brought.
  BLH="$BASE/api/host/events/$BLSLUG/contributions"
  check "the host seeds a count"                   200 -H "Cookie: $ZAEME_TEST_SESSION_COOKIE" "${JSON[@]}" \
    -X POST "$BLH" -d '{"title":"Salad","category":"food","quantityNeeded":4,"unit":"bowls"}'
  equals "...wanted by four, brought by nobody"    "$(bring_state "$(body -H "Cookie: $ZAEME_TEST_SESSION_COOKIE" "$BASE/api/host/events/$BLSLUG")" 'Salad')" "4/0/4/open/nobody"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

echo
echo "== suggesting a whole bring list (Bermos/zaeme#45) =="
# NOBODY KNOWS WHAT A POTLUCK FOR TWELVE NEEDS. One tap on an empty list, a
# static set scaled to the yes-RSVPs, edited before it is applied — and a copy
# of a past event of the same type, which brings the items and NOT the claims.
#
# THE WHOLE FEATURE IS ON THE HOST SURFACE, so every check here needs the
# planner's cookie: `/api/v1` gained no verb for this (Enterprise generates its
# tools from the contract, and a suggestion is a person's gesture, not a
# machine's), and the invite link must not be able to reach it at all.
#
# WHAT THESE PROVE THAT VITEST CANNOT. `test/bring-list-suggestions.test.ts`
# executes the arithmetic and the duplicate rule as pure functions — that is
# where "four people and twelve do not get the same list" lives. What it cannot
# see is a handler that ignores the body it was sent, a second apply that writes
# a second Wine, or a copy that carries somebody else's name across. Those need
# rows in Postgres and are proved here or nowhere.
#
# IT MINTS EVERY EVENT IT USES, because this suite re-runs against the rows the
# last run left behind, and a suggestion's counts are exact.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  HOST_COOKIE=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")

  # ---- a party of twelve, which is the issue's own example ----
  SGP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke suggest party $SUFFIX\",\"type\":\"party\",\"startsAt\":\"2027-08-14T20:00:00+02:00\"}")
  SGSLUG=$(printf '%s' "$SGP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGSLUG/status" -d '{"status":"published"}' > /dev/null
  SGTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGSLUG/invites" -d '{"label":"Suggest smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  SGGET="$BASE/api/host/events/$SGSLUG/contributions/suggestions"
  echo "  party: $SGSLUG"

  # TWELVE HEADS, as six friends each bringing somebody — so a scaler that
  # counted RSVP ROWS rather than people would answer 6 and every count below
  # would halve.
  for i in 1 2 3 4 5 6; do
    body "${JSON[@]}" -X POST "$BASE/api/invites/$SGTOK/rsvp" \
      -d "{\"status\":\"yes\",\"plusOne\":true,\"plusOneName\":\"Plus $i\",\"guestName\":\"Yes $i\",\"guestEmail\":\"yes$i-45-$SUFFIX@example.com\"}" > /dev/null
  done
  # AND THREE WHO ARE NOT EATING, each with a +1 of their own so that counting
  # them would be visible rather than marginal: a maybe is a judgement the host
  # makes, a no is a no, and "cheering from afar" is somebody who is not in the
  # room. `summariseRsvps().headcount` counts the last of those and is
  # deliberately not what this feature asks.
  for s in maybe no cheering; do
    body "${JSON[@]}" -X POST "$BASE/api/invites/$SGTOK/rsvp" \
      -d "{\"status\":\"$s\",\"plusOne\":true,\"guestName\":\"Not $s\",\"guestEmail\":\"$s-45-$SUFFIX@example.com\"}" > /dev/null
  done

  SUG=$(body "${HOST_COOKIE[@]}" "$SGGET")
  equals "a party of twelve, from the yes-RSVPs alone" "$(suggest_state "$SUG")" "static/12/6/none"
  equals "...wants six bottles of wine"            "$(suggest_count "$SUG" 'Wine')" "6"
  equals "...twenty-four beers"                    "$(suggest_count "$SUG" 'Beer')" "24"
  equals "...three bags of ice"                    "$(suggest_count "$SUG" 'Ice')" "3"
  equals "...and eighteen cups"                    "$(suggest_count "$SUG" 'Cups')" "18"
  excludes "nothing is written by looking"         "$(body "${HOST_COOKIE[@]}" "$BASE/api/host/events/$SGSLUG")" '"title":"Wine"'

  # ---- THE TYPES THE ISSUE LEFT OUT, which include the DEFAULT ----
  # `hosted` is what an event created without a type is, and what every showing
  # of a series is (`scheduleOccurrence` inserts it). Under the issue as written
  # — party, series and trip named, `hosted` and `concert` not — the commonest
  # event on any instance would get a one-tap button that does nothing.
  HSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke suggest hosted $SUFFIX\",\"startsAt\":\"2027-08-15T19:00:00+02:00\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  HSUG=$(body "${HOST_COOKIE[@]}" "$BASE/api/host/events/$HSLUG/contributions/suggestions")
  equals "the DEFAULT type suggests a real list"   "$(suggest_state "$HSUG")" "static/0/4/none"
  equals "...at each line's minimum while nobody has said yes" "$(suggest_count "$HSUG" 'Something sweet')" "4"

  # A gig gets a SENTENCE, not an empty box: there is nothing to bring, and
  # `0/none` — no items and no reason — is the shape of a dead control.
  CSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke suggest gig $SUFFIX\",\"type\":\"concert\",\"startsAt\":\"2027-08-16T20:00:00+02:00\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  CSUG=$(body "${HOST_COOKIE[@]}" "$BASE/api/host/events/$CSLUG/contributions/suggestions")
  equals "a gig has no items AND says why not"     "$(suggest_state "$CSUG")" "static/0/0/reason"
  contains "...in words a screen can show"         "$CSUG" 'nothing to bring to a gig'

  # ---- a trip, and the item that does not scale ----
  SGTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke suggest trip $SUFFIX\",\"type\":\"trip\",\"startsAt\":\"2020-02-11T09:00:00+01:00\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  TSUG=$(body "${HOST_COOKIE[@]}" "$BASE/api/host/events/$SGTRIP/contributions/suggestions")
  equals "a trip suggests breakfast and a corkscrew" "$(suggest_state "$TSUG")" "static/0/5/none"
  equals "...one corkscrew, which is not per person" "$(suggest_count "$TSUG" 'A corkscrew')" "1"
  check "the trip takes a bring-list item"         201 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGTRIP/contributions" \
    -d '{"title":"Hiking snacks","category":"food"}'

  # ---- applying it, editing it, and applying it AGAIN ----
  # THE BODY IS THE HOST'S, not the suggestion's: two of the six lines, one of
  # them at a count the GET never proposed. A handler that re-derived the
  # suggestion instead of writing what it was sent passes every check above and
  # fails these.
  APP=$(body "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" \
    -d '{"items":[{"title":"Wine","category":"drink","unit":"bottles","quantityNeeded":4},{"title":"Ice","category":"other","unit":"bags","quantityNeeded":3}]}')
  contains "the host applies the two lines they kept" "$APP" '"added":2'
  equals "...at the count THEY typed, not the suggested six" "$(bring_state "$APP" 'Wine')" "4/0/4/open/nobody"
  equals "...and the other four lines were not written" "$(bring_state "$APP" 'Beer')" "no-such-item"

  # APPLYING TWICE MUST NOT DUPLICATE — an acceptance criterion, and the one
  # `bring_state` alone cannot see: it finds the first match, so two Wines read
  # exactly like one. `bring_copies` counts them.
  APP2=$(body "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" \
    -d '{"items":[{"title":"Wine","category":"drink","unit":"bottles","quantityNeeded":6},{"title":"Ice","category":"other","unit":"bags","quantityNeeded":3}]}')
  contains "applying the same list again adds nothing" "$APP2" '"added":0'
  contains "...and says which lines it left alone"  "$APP2" '"skipped":["Wine","Ice"]'
  equals "...there is still exactly ONE Wine"       "$(bring_copies "$APP2" 'Wine')" "1"
  equals "...and its count is the host's 4, not re-stated as 6" "$(bring_state "$APP2" 'Wine')" "4/0/4/open/nobody"

  # The same thing typed differently is the same thing to ask somebody for.
  APP3=$(body "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" \
    -d '{"items":[{"title":"  wine  ","quantityNeeded":99},{"title":"Crisps and nuts","category":"food","unit":"bowls","quantityNeeded":6}]}')
  contains "a differently-typed title is a duplicate" "$APP3" '"skipped":["  wine  "]'
  equals "...so there is still one Wine, at four"   "$(bring_copies "$APP3" 'Wine')" "1"
  equals "...while the genuinely new line lands"    "$(bring_state "$APP3" 'Crisps and nuts')" "6/0/6/open/nobody"

  # ---- copying a past party: THE ITEMS, AND NOT THE CLAIMS ----
  SGPASTBODY=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke last party $SUFFIX\",\"type\":\"party\",\"startsAt\":\"2020-03-07T20:00:00+01:00\"}")
  SGPAST=$(printf '%s' "$SGPASTBODY" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGPAST/status" -d '{"status":"published"}' > /dev/null
  PTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGPAST/invites" -d '{"label":"Last party"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGPAST/contributions" \
    -d '{"title":"Sangria","category":"drink","quantityNeeded":4,"unit":"jugs"}' > /dev/null
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGPAST/contributions" -d '{"title":"Candles","category":"other"}' > /dev/null
  SAID=$(bring_id "$(body "${AUTH[@]}" "$API/events/$SGPAST/contributions")" 'Sangria')
  check "somebody claimed the sangria last time"   200 "${JSON[@]}" -X POST "$BASE/api/invites/$PTOK/contributions/$SAID/claim" \
    -d "{\"guestName\":\"Ada\",\"guestEmail\":\"ada-45-$SUFFIX@example.com\",\"quantity\":4}"
  equals "...so that list is a claimed one"         "$(bring_state "$(body "${AUTH[@]}" "$API/events/$SGPAST/contributions")" 'Sangria')" "4/4/0/done/ada-45-$SUFFIX@example.com"

  # A PARTY THAT HAS NOT HAPPENED YET, with a list on it, so that "a host who
  # has RUN a party before" is asserted against a fixture where the wrong answer
  # differs from the right one. Without this the past filter is unfalsifiable:
  # every other event in this block is excluded by its type or by being this one.
  SGUP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke next party $SUFFIX\",\"type\":\"party\",\"startsAt\":\"2031-06-06T20:00:00+02:00\"}" \
    | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$SGUP/contributions" -d '{"title":"Fireworks"}' > /dev/null

  SGSRC=$(body "${HOST_COOKIE[@]}" "$SGGET")
  equals "the past party is offered, with its size"  "$(source_items "$SGSRC" "$SGPAST")" "2"
  equals "a party that has not happened yet is not"  "$(source_items "$SGSRC" "$SGUP")" "no-such-source"
  equals "...nor is a TRIP with a list on it"        "$(source_items "$SGSRC" "$SGTRIP")" "no-such-source"
  equals "...nor this event itself"                  "$(source_items "$SGSRC" "$SGSLUG")" "no-such-source"

  COPY=$(body "${HOST_COOKIE[@]}" "$SGGET?from=$SGPAST")
  equals "copying it previews that evening's items" "$(suggest_state "$COPY")" "event/12/2/none"
  equals "...with the count that was on them"       "$(suggest_count "$COPY" 'Sangria')" "4"
  equals "...and a free-text item stays free text"  "$(suggest_count "$COPY" 'Candles')" "none"
  excludes "...and NOT the person who claimed it"   "$COPY" "ada-45-$SUFFIX"
  excludes "...nor a claims array at all"           "$COPY" '"claims"'

  # THE PREVIEW IS APPLIED VERBATIM, not re-typed here: a hand-written body
  # cannot carry a field the preview should never have had, so a leak would ride
  # through it invisibly.
  CAP=$(body "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" -d "$(suggest_body "$COPY")")
  contains "the copy lands as ordinary items"       "$CAP" '"added":2'
  equals "...and the sangria arrives UNCLAIMED"     "$(bring_state "$CAP" 'Sangria')" "4/0/4/open/nobody"
  equals "...and the free-text item has no count"   "$(bring_state "$CAP" 'Candles')" "none/0/none/open/nobody"
  equals "...while LAST year's list still has its claim" "$(bring_state "$(body "${AUTH[@]}" "$API/events/$SGPAST/contributions")" 'Sangria')" "4/4/0/done/ada-45-$SUFFIX@example.com"

  # ---- the refusals ----
  check "a trip's list does not fit a party"       422 "${HOST_COOKIE[@]}" "$SGGET?from=$SGTRIP"
  check "...nor does this event's own list"        422 "${HOST_COOKIE[@]}" "$SGGET?from=$SGSLUG"
  check "...nor a slug that is not an event"       404 "${HOST_COOKIE[@]}" "$SGGET?from=no-such-event-at-all"
  check "an empty list of items is refused"        400 "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" -d '{"items":[]}'
  check "a count of zero is refused"               400 "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" -d '{"items":[{"title":"Nothing","quantityNeeded":0}]}'
  check "an item with no title is refused"         400 "${HOST_COOKIE[@]}" "${JSON[@]}" -X POST "$SGGET" -d '{"items":[{"quantityNeeded":2}]}'

  # ---- and the credential, in both directions ----
  # A suggestion is a planner's gesture on the host session. The service token
  # has no verb for it (nothing was added to `/api/v1`), and the capability URL
  # — which any guest holds — must not reach a route that writes a whole list.
  check "the service token cannot suggest"         401 "${AUTH[@]}" "$SGGET"
  check "...nor apply"                             401 "${AUTH[@]}" "${JSON[@]}" -X POST "$SGGET" -d '{"items":[{"title":"X"}]}'
  check "no credential at all is 401"              401 "$SGGET"
  check "the invite link has no such route"        404 "$BASE/api/invites/$SGTOK/contributions/suggestions"
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ] && [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  # COPYING IS A READ OF SOMEBODY ELSE'S EVENT, so the planner has to be a
  # planner THERE too. Without that check any slug on the instance would hand
  # over its bring list to anybody who could name it — and a bring list carries
  # what a group eats, drinks and has trouble with.
  #
  # The direction matters: an event created through `/api/host/events` attaches
  # the INSTANCE OWNER as a co-planner (ADR-0019 §4), so the owner legitimately
  # reaches the other account's events. The party minted above through `/api/v1`
  # has exactly one planner, and the second account is not it.
  OGP=$(body -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" -X POST "$BASE/api/host/events" \
    -d "{\"title\":\"Smoke other party $SUFFIX\",\"type\":\"party\",\"startsAt\":\"2027-09-02T20:00:00+02:00\"}")
  OGSLUG=$(printf '%s' "$OGP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  OGGET="$BASE/api/host/events/$OGSLUG/contributions/suggestions"
  check "another host suggests on their OWN party" 200 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "$OGGET"
  check "...but cannot copy a list they do not plan" 403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "$OGGET?from=$SGSLUG"
  check "...and cannot suggest on somebody else's" 403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "$SGGET"
  check "...nor apply to it"                       403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" \
    -X POST "$SGGET" -d '{"items":[{"title":"Uninvited"}]}'
else
  echo "  skip  set both ZAEME_TEST_SESSION_COOKIE and ZAEME_TEST_GUEST_COOKIE to run these"
fi

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
#                 33.34 / 33.34 / 33.33, so two of the three shares differ — the
#                 MIDDLE one is 33.34 either way, which is exactly why this is
#                 asserted with `equals` on the whole vector rather than with a
#                 `contains` on any one figure
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
# than at the recorded weights answers 3334 3334 3333 here — the same in the
# middle position and different in the other two, so the assertion has to be on
# the whole vector.
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
  # ---- THE BODY THE FORM ACTUALLY SENDS (#27 review) ----
  # Everything above composes its own bodies. `BudgetCard.vue` composes a
  # different one, and the gap between them is where the defect lived: it sent
  # `splitMode` and `participants` on EVERY correction, so a title-only fix took
  # the "replace the split" path and re-split a hand-pinned `even` expense
  # evenly — 40.00/30.00/30.00 became 33.34/33.33/33.33, the toast said "Expense
  # updated", and this ledger keeps no history to recover it from. Nothing in
  # this file executed that shape, which is why it survived review twice.
  RACUNCAT=$(account_id "$(body "${AUTH[@]}" "$API/events/$ESLUG/budget")" "Uncategorised")
  FORMHEAD="\"accountId\":\"$RACUNCAT\",\"currency\":\"CHF\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\""
  RAC2=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$RAC_ID" \
    -d "{\"title\":\"Raclette, second night\",$FORMHEAD,\"amountCents\":10000}")
  equals "the form's title-only correction leaves a hand-pinned split ALONE" "$(entry_shares "$RAC2" "Raclette, second night")" "4000 3000 3000"
  equals "...in an entry that still balances"        "$(ledger_imbalance "$RAC2")" "0"
  # ...and the body it sends once somebody HAS touched the split still replaces it.
  RAC3=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$RAC_ID" \
    -d "{\"title\":\"Raclette, second night\",$FORMHEAD,\"amountCents\":12000,\"splitMode\":\"exact\",\"participants\":[{\"name\":\"A\",\"email\":\"a@e.com\",\"amountCents\":6000},{\"name\":\"B\",\"email\":\"b@e.com\",\"amountCents\":3000},{\"name\":\"C\",\"email\":\"c@e.com\",\"amountCents\":3000}]}")
  equals "...while the body it sends once it HAS been touched replaces it" "$(entry_shares "$RAC3" "Raclette, second night")" "6000 3000 3000"

  # ---- THE EVIDENCE RULE, ON THE SURFACE A PERSON USES (#71) ----
  # The form prefills the rate field — with today's quote on a write, with the
  # frozen rate on an edit — and used to send it back verbatim. So every
  # correction relabelled the row `manual` ("a figure checked against a
  # statement") and every amount correction resent the OLD stated total beside
  # the NEW receipt. It now sends neither unless the field was changed, which is
  # what puts these two branches on the human path at all: until this, the
  # centrepiece of #27's conversion rule was reachable only from /api/v1.
  FERRY=$(body "${EOWNER[@]}" "${JSON[@]}" -X POST "$MEEXPE" \
    -d '{"title":"Ferry","amountCents":10000,"currency":"EUR","fxRate":"0.9412","paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
  FY_ID=$(expense_id "$FERRY" "Ferry")
  contains "a rate somebody typed there is a checked figure" "$FERRY" '"fxRate":"0.9412","fxRateSource":"manual","statedAmountCents":9412,"statedCurrency":"CHF"'
  FY1=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$FY_ID" \
    -d "{\"title\":\"Ferry, return\",\"accountId\":\"$RACUNCAT\",\"currency\":\"EUR\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"amountCents\":10000}")
  contains "the form's title-only correction leaves a checked figure checked" "$FY1" '"fxRate":"0.9412","fxRateSource":"manual","statedAmountCents":9412,"statedCurrency":"CHF"'
  FY2=$(body "${EOWNER[@]}" "${JSON[@]}" -X PATCH "$MEEXPE/$FY_ID" \
    -d "{\"title\":\"Ferry, return\",\"accountId\":\"$RACUNCAT\",\"currency\":\"EUR\",\"paidByName\":\"A\",\"paidByEmail\":\"a@e.com\",\"amountCents\":20000}")
  # 200.00 EUR at the rate this row was frozen at is exactly 188.24 CHF.
  contains "...and its AMOUNT correction rides on the frozen rate" "$FY2" '"amountCents":20000,"currency":"EUR","amountBaseCents":18824,"baseCurrency":"CHF","fxRate":"0.9412"'
  # THE LIE THIS REPLACES: resending the prefilled stated total would have
  # recorded "EUR 200.00 cost me CHF 94.12" as something somebody checked.
  contains "...with the row no longer claiming anybody checked it" "$FY2" '"fxRateSource":"fetched","statedAmountCents":null,"statedCurrency":null'
  equals "...still balancing"                        "$(ledger_imbalance "$FY2")" "0"

  EAUD=$(audit_await "$BASE/api/admin/audit?actorKind=participant&surface=me&eventSlug=$ESLUG&limit=20" \
    "\"path\":\"/api/me/events/$ESLUG/expenses/$CH_ID\"")
  contains "the audit records the correction, by path" "$EAUD" "\"path\":\"/api/me/events/$ESLUG/expenses/$CH_ID\""
  contains "...against the account that made it, not the one that recorded it" "$EAUD" "\"actorLabel\":\"$EGEMAIL\""
else
  echo "  skip  set both ZAEME_TEST_SESSION_COOKIE and ZAEME_TEST_GUEST_COOKIE to run these"
fi

echo
echo "== settling up: a paid debt leaves the balance (Bermos/zaeme#28) =="
# EVERY FIGURE HERE WAS WORKED OUT BY HAND in exact integers and is written as a
# literal, against a real Postgres. The fixture is LOPSIDED on purpose: CHF
# 300.00 owed 50 / 150 / 100 is not what any even, weighted or percentage split
# of that total produces by accident, and the two debts are different sizes — so
# the PLAN has an order (balances sort by net descending, so the SMALLER debt is
# matched first) that an implementation ignoring the amounts gets wrong.
#
#   Chalet, CHF 300.00 fronted by Ana, owed 50 / 150 / 100
#       Ana +250.00 · Ben −150.00 · Cleo −100.00
#       plan: Cleo pays Ana 100.00, then Ben pays Ana 150.00
#   Cleo pays Ana 100.00   → Cleo 0, Ana +150.00, one leg left
#   Ben pays Ana 40.00     → PARTIAL: Ben −110.00, and the plan asks for 110.00
#   ...deleted             → Ben −150.00 again, exactly what it was before it
#   Ben pays Ana 150.00    → everybody at zero and nothing left to suggest
#   Cleo pays Ana 25.00    → EXCESS: Cleo +25.00, and the plan asks ANA for it
#   ...deleted             → square again
#   the trip moves to EUR at 1.0645 — a franc is worth MORE than a euro, and a
#       fixture with that backwards proves its arithmetic against nonsense —
#       with three entries already settled: 300.00 → 319.35, its three debts
#       re-expressed ONE AT A TIME (#59) as 53.23 / 159.68 / 106.45, which come
#       to 319.36 and leave a centime on `Rounding`; both transfers re-expressed
#       with them, so everybody is STILL at zero and the total — which never
#       counted a transfer — is 319.35
#   the Chalet is corrected to 360.00 (80 / 180 / 100 as spent) at that frozen
#       rate: 383.22, apportioned 85.16 / 191.61 / 106.45. Settling re-opens by
#       exactly 31.93 and the plan asks Ben for it.
#
# THE BODIES ARE THE ONES `BudgetCard.vue` COMPOSES, field for field — four
# names and an amount, with `note` only when somebody typed one. #27 shipped two
# money-moving defects that every check in this file was blind to because
# nothing executed the shape the form actually sends.
STRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke settle $SUFFIX\",\"type\":\"trip\"}" \
  | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$STRIP/status" -d '{"status":"published"}' > /dev/null
SETTLE="$BASE/api/me/events/$STRIP/settlements"
SEXP="$BASE/api/me/events/$STRIP/expenses"
PAY='{"fromName":"Cleo","fromEmail":"cleo@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":10000}'
echo "  trip: $STRIP"

# No cookie, no payment: recording one is a claim about a person's money and
# needs an account, exactly as an expense does (#48).
check "an anonymous payment is refused"            401 "${JSON[@]}" -X POST "$SETTLE" -d "$PAY"
check "...and a service token is not an account"   401 "${AUTH[@]}" "${JSON[@]}" -X POST "$SETTLE" -d "$PAY"
if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  check "...nor is an account with no standing"    403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" -X POST "$SETTLE" -d "$PAY"
else
  echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a NON-participant session to run this"
fi

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  SETR=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  # The trip settles in CHF, said here rather than assumed: the instance default
  # is a VALUE somebody can change (#25 D6) and every figure below is in it.
  # From === to is a no-op that answers 200, so this is safe either way.
  body "${SETR[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$STRIP/currency" -d '{"currency":"CHF"}' > /dev/null

  OWED=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$SEXP" -d '{"title":"Chalet","amountCents":30000,"splitMode":"exact","paidByName":"Ana","paidByEmail":"ana@e.com","participants":[{"name":"Ana","email":"ana@e.com","amountCents":5000},{"name":"Ben","email":"ben@e.com","amountCents":15000},{"name":"Cleo","email":"cleo@e.com","amountCents":10000}]}')
  equals "a lopsided debt starts the trip off" "$(entry_shares "$OWED" "Chalet")" "5000 15000 10000"
  equals "...and the plan matches the SMALLER debt first" \
    "$(json_field "$OWED" budget.settlements.0.fromName)>$(json_field "$OWED" budget.settlements.0.toName):$(json_field "$OWED" budget.settlements.0.amountCents)" \
    "Cleo>Ana:10000"
  equals "...then the larger one"                                                  \
    "$(json_field "$OWED" budget.settlements.1.fromName)>$(json_field "$OWED" budget.settlements.1.toName):$(json_field "$OWED" budget.settlements.1.amountCents)" \
    "Ben>Ana:15000"

  # MARK AS PAID, on the surface the card posts to, with the body it composes.
  PAID1=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" -d "$PAY")
  contains "a recorded payment clears exactly that debt" "$PAID1" '"email":"cleo@e.com","paidCents":10000,"owedCents":10000,"netCents":0'
  contains "...and leaves the other one alone"           "$PAID1" '"email":"ben@e.com","paidCents":0,"owedCents":15000,"netCents":-15000'
  equals "...so one leg is left"                         "$(json_field "$PAID1" budget.settlements.length)" "1"
  equals "...which is the one that was not paid"         \
    "$(json_field "$PAID1" budget.settlements.0.fromName)>$(json_field "$PAID1" budget.settlements.0.toName):$(json_field "$PAID1" budget.settlements.0.amountCents)" \
    "Ben>Ana:15000"
  # THE CRITERION THE WHOLE SHAPE EXISTS FOR: CHF 300.00 of expenses and CHF
  # 100.00 of transfers still reports CHF 300.00. A `kind` flag nobody set, or a
  # category line on the transfer, and this is 400.00.
  equals "...while the trip still cost what it cost"     "$(json_field "$PAID1" budget.totalCents)" "30000"
  equals "a payment is TWO lines and no more"            "$(entry_lines "$PAID1" "Cleo → Ana")" "2"
  # `"category":null` AND `"categoryAccountId":null`, together: an entry with no
  # category line has no category, and answering "Uncategorised" filed every
  # transfer under a real account it never touched for anything grouping on the
  # name alone (#74 review).
  contains "...posting to no category account at all"    "$PAID1" '"title":"Cleo → Ana","category":null,"categoryAccountId":null'
  equals "...in a ledger that still balances"            "$(ledger_imbalance "$PAID1")" "0"
  equals "...and a plan that still closes"               "$(plan_closes "$PAID1")" "closed"

  # PARTIAL: 40.00 of the 150.00 Ben owes. Not a fraction of it and not a round
  # number of it — an implementation that closed the debt outright, or that used
  # the plan's figure rather than the one typed, differs from this.
  PART=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" \
    -d '{"fromName":"Ben","fromEmail":"ben@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":4000,"note":"Twint, Tuesday"}')
  contains "a partial payment reduces the debt by THAT much" "$PART" '"email":"ben@e.com","paidCents":4000,"owedCents":15000,"netCents":-11000'
  equals "...and the plan asks for the rest"                 \
    "$(json_field "$PART" budget.settlements.0.fromName)>$(json_field "$PART" budget.settlements.0.toName):$(json_field "$PART" budget.settlements.0.amountCents)" \
    "Ben>Ana:11000"
  contains "...carrying the note somebody typed"             "$PART" '"note":"Twint, Tuesday"'
  equals "...with the total untouched by it too"             "$(json_field "$PART" budget.totalCents)" "30000"

  # …AND IT CAN BE TAKEN BACK. A settlement is a claim about the physical world;
  # a mistyped one that nobody can undo leaves the ledger asserting a transfer
  # that never happened.
  # THE ID COMES FROM THE WRITE THAT MADE IT, never from the title. A payment's
  # title is GENERATED from the two names, so two payments between one pair are
  # two entries with one name and `expense_id` answers about the FIRST — which
  # silently deletes the wrong row and fails five checks downstream for reasons
  # that have nothing to do with what they test. Every settlement write answers
  # with `budget.expenseId`, which is exactly the row it just wrote.
  PART_ID=$(json_field "$PART" budget.expenseId)
  UNDO=$(body "${SETR[@]}" -X DELETE "$SETTLE/$PART_ID")
  contains "removing it restores the balance exactly" "$UNDO" '"email":"ben@e.com","paidCents":0,"owedCents":15000,"netCents":-15000'
  equals "...and the entry is gone with it"           "$(entry_lines "$UNDO" "Ben → Ana")" "no-such-entry"
  equals "...leaving the plan as it was before"       \
    "$(json_field "$UNDO" budget.settlements.0.fromName)>$(json_field "$UNDO" budget.settlements.0.toName):$(json_field "$UNDO" budget.settlements.0.amountCents)" \
    "Ben>Ana:15000"

  # EXCESS. Ben owes 150.00 and sends 200.00 — he rounded up, or paid for
  # something else. Nothing refuses it and nothing caps it at the debt: he stops
  # being a debtor and becomes a creditor for the 50.00 he is now out, which is
  # true, and the plan starts asking ANA for it.
  OVER=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" \
    -d '{"fromName":"Ben","fromEmail":"ben@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":20000}')
  equals "paying more than you owe turns the plan around" \
    "$(json_field "$OVER" budget.settlements.0.fromName)>$(json_field "$OVER" budget.settlements.0.toName):$(json_field "$OVER" budget.settlements.0.amountCents)" \
    "Ana>Ben:5000"
  contains "...and the payer is now the one owed"        "$OVER" '"email":"ben@e.com","paidCents":20000,"owedCents":15000,"netCents":5000'
  OVER_ID=$(json_field "$OVER" budget.expenseId)
  BACK=$(body "${SETR[@]}" -X DELETE "$SETTLE/$OVER_ID")
  equals "...until it is taken back off again"           \
    "$(json_field "$BACK" budget.settlements.0.fromName)>$(json_field "$BACK" budget.settlements.0.toName):$(json_field "$BACK" budget.settlements.0.amountCents)" \
    "Ben>Ana:15000"

  SQUARE=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" \
    -d '{"fromName":"Ben","fromEmail":"ben@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":15000}')
  contains "the last suggested transfer lands Ana on zero"  "$SQUARE" '"email":"ana@e.com","paidCents":30000,"owedCents":30000,"netCents":0'
  contains "...and Ben"                                     "$SQUARE" '"email":"ben@e.com","paidCents":15000,"owedCents":15000,"netCents":0'
  contains "...and Cleo"                                    "$SQUARE" '"email":"cleo@e.com","paidCents":10000,"owedCents":10000,"netCents":0'
  equals "...with nothing left to suggest"                  "$(json_field "$SQUARE" budget.settlements.length)" "0"
  equals "...and the trip still cost CHF 300.00"            "$(json_field "$SQUARE" budget.totalCents)" "30000"

  # The refusals a person can actually hit.
  check "paying yourself is refused"                 422 "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" \
    -d '{"fromName":"Ana","fromEmail":"ana@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":5000}'
  check "...as is a payment of nothing"              400 "${SETR[@]}" "${JSON[@]}" -X POST "$SETTLE" \
    -d '{"fromName":"Ben","fromEmail":"ben@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":0}'
  CHALET_ID=$(expense_id "$SQUARE" "Chalet")
  SETTLED_ID=$(json_field "$SQUARE" budget.expenseId)
  # The payments route is not a way around `removeExpense`'s narrower rule.
  check "an EXPENSE cannot be removed as a payment" 422 "${SETR[@]}" -X DELETE "$SETTLE/$CHALET_ID"
  # …and a transfer cannot be relabelled a cost, which would put money people
  # handed each other into the trip total.
  check "a payment cannot be given a category"      422 "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$SETTLED_ID" \
    -d "{\"accountId\":\"$(account_id "$SQUARE" "Uncategorised")\"}"
  # Read back over a THIRD surface, because "the refusal wrote nothing" is a
  # claim about the database and not about the response that refused.
  equals "...so the total is what it was"           "$(json_field "$(body "${AUTH[@]}" "$API/events/$STRIP/budget")" totalCents)" "30000"

  # NO LOCK-OUT ONCE PEOPLE HAVE SETTLED (#59, and the owner's rule): the trip's
  # currency still moves, and a settlement re-derives with everything else
  # because it is an entry like everything else. Three entries recomputed at
  # 1.0645 leave all three people at zero — 300.00 → 319.35, its debts 53.23 /
  # 159.68 / 106.45, and the two transfers 106.45 and 159.68 against them.
  EUR=$(body "${SETR[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$STRIP/currency" -d '{"currency":"EUR","fxRate":"1.0645"}')
  contains "a settled trip can still change currency"  "$EUR" '"entriesRecomputed":3'
  equals "...and everybody stays square"               "$(json_field "$EUR" budget.settlements.length)" "0"
  equals "...at the recomputed total"                  "$(json_field "$EUR" budget.totalCents)" "31935"
  # EVERY money column of the transfer, against figures worked out by hand, and
  # the shape with them: what was handed over never moves (CHF 100.00), what it
  # settles for is re-expressed (EUR 106.45), the rate on the row says so, and it
  # STILL touches no category account. An `entry_shares` assertion would have
  # passed unchanged here — an as-spent share is the same before and after.
  contains "...with the transfer re-expressed with them" "$EUR" '"title":"Cleo → Ana","category":null,"categoryAccountId":null,"amountCents":10000,"currency":"CHF","amountBaseCents":10645,"baseCurrency":"EUR","fxRate":"1.0645","fxRateSource":"fetched"'
  contains "...down to its single debit"                 "$EUR" '"shares":[{"name":"Ana","email":"ana@e.com","amountCents":10000,"amountBaseCents":10645,"weight":null}]'
  # THE CENTIME THE RECOMPUTE LEAVES, asserted rather than described. Converting
  # three debts one at a time gives 53.23 + 159.68 + 106.45 = 319.36 against a
  # total of 319.35, and that difference is a real artefact of the change rather
  # than money moved between friends — so it goes on `Rounding`, where somebody
  # can read it, and the member side still nets to zero.
  contains "...with the centime it leaves on Rounding" "$EUR" '"name":"Rounding","email":null,"isSystem":true,"debitCents":1,"creditCents":0'
  equals "...in a ledger that still balances"          "$(ledger_imbalance "$EUR")" "0"
  equals "...and a plan that still closes"             "$(plan_closes "$EUR")" "closed"

  # …and an expense can still be CORRECTED afterwards, which re-opens exactly
  # the difference rather than refusing the edit. 360.00 at the rate this entry
  # is frozen at is 383.22, apportioned 85.16 / 191.61 / 106.45 — so Ben, who has
  # paid 159.68, is short by exactly 31.93 and nobody else moves.
  FIXED=$(body "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$CHALET_ID" \
    -d '{"amountCents":36000,"splitMode":"exact","participants":[{"name":"Ana","email":"ana@e.com","amountCents":8000},{"name":"Ben","email":"ben@e.com","amountCents":18000},{"name":"Cleo","email":"cleo@e.com","amountCents":10000}]}')
  equals "correcting an expense after settling is allowed" "$(entry_shares "$FIXED" "Chalet")" "8000 18000 10000"
  equals "...and re-opens exactly the difference"          \
    "$(json_field "$FIXED" budget.settlements.0.fromName)>$(json_field "$FIXED" budget.settlements.0.toName):$(json_field "$FIXED" budget.settlements.0.amountCents)" \
    "Ben>Ana:3193"
  equals "...against the recomputed total"                 "$(json_field "$FIXED" budget.totalCents)" "38322"
  equals "...in a ledger that still balances"              "$(ledger_imbalance "$FIXED")" "0"

  # THE OTHER SURFACE THE CARD POSTS TO. `BudgetCard.vue` renders on the host
  # page as well, against /api/host — a second handler with a second zod schema,
  # which the /api/me checks above cannot exercise at all.
  HOSTPAY=$(body "${SETR[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$STRIP/settlements" \
    -d '{"fromName":"Ben","fromEmail":"ben@e.com","toName":"Ana","toEmail":"ana@e.com","amountCents":3193}')
  equals "a payment recorded on the HOST surface settles it" "$(json_field "$HOSTPAY" budget.settlements.length)" "0"
  contains "...landing the person who owed it on zero"       "$HOSTPAY" '"email":"ben@e.com","paidCents":19161,"owedCents":19161,"netCents":0'

  # WHAT AN EDIT MAY NOT DO TO A TRANSFER (#74 review). A settlement is a SHAPE
  # — one credit, one debit, no category — and `updateExpense` is reachable from
  # three surfaces, so each field that would break it is refused rather than
  # left to be discovered. All 422 and not 400: the DOMAIN understood the
  # request and said no, which is a different finding from a schema that never
  # let it through.
  HOSTPAY_ID=$(json_field "$HOSTPAY" budget.expenseId)
  check "a payment cannot be split between three people" 422 "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$HOSTPAY_ID" \
    -d '{"participants":[{"name":"Ana","email":"ana@e.com"},{"name":"Ben","email":"ben@e.com"},{"name":"Cleo","email":"cleo@e.com"}]}'
  check "...nor given a split mode"                      422 "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$HOSTPAY_ID" \
    -d '{"splitMode":"exact","participants":[{"name":"Ana","email":"ana@e.com","amountCents":3193}]}'
  check "...nor titled by hand"                          422 "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$HOSTPAY_ID" \
    -d '{"title":"Dinner, obviously"}'
  # …and the refusals WROTE NOTHING, read back from a third surface rather than
  # inferred from the 422s. Not `entry_lines "Ben → Ana"`: two payments between
  # that pair exist by now and the helper answers about the FIRST, so it would
  # pass while the second had been split three ways. The total says no category
  # line was added, and Cleo's balance says nobody was debited who should not
  # have been — both figures move under exactly the writes being refused.
  RETRY=$(body "${AUTH[@]}" "$API/events/$STRIP/budget")
  equals "...and no category line was written"           "$(json_field "$RETRY" totalCents)" "38322"
  contains "...nor anybody debited by the refused split" "$RETRY" '"email":"cleo@e.com","paidCents":10645,"owedCents":10645,"netCents":0'

  # WHAT AN EDIT MAY DO: correct who was paid. The title is DERIVED from the two
  # names, so it moves with them — frozen, it would go on naming a pair that had
  # been corrected, which the card hides (it reads the fields) and `/api/v1` and
  # the audit log do not.
  RETARGET=$(body "${SETR[@]}" "${JSON[@]}" -X PATCH "$SEXP/$HOSTPAY_ID" \
    -d '{"participants":[{"name":"Cleo","email":"cleo@e.com"}]}')
  contains "correcting who was paid renames the payment"  "$RETARGET" '"title":"Ben → Cleo","category":null,"categoryAccountId":null'
  equals "...and is still the same two-line transfer"     "$(entry_lines "$RETARGET" "Ben → Cleo")" "2"
  contains "...with the money on the new recipient"       "$RETARGET" '"email":"cleo@e.com","paidCents":10645,"owedCents":13838,"netCents":-3193'

  # THE HOST SURFACE'S DELETE, EXECUTED. It was covered by nothing at first —
  # every DELETE in this block went to /api/me — and `removeSettlementAsPlanner
  # (userId, slug, settlementId)` is three interchangeable strings, so
  # transposing two of them type-checks, passes all 364 vitest tests and 404s
  # every ✕ on the host page (#74 review, MEMORY's #50 lesson on a new surface).
  HOSTGONE=$(body "${SETR[@]}" -X DELETE "$BASE/api/host/events/$STRIP/settlements/$HOSTPAY_ID")
  # ON THE ENTRY COUNT, not on `entry_lines … "no-such-entry"`: the mutation this
  # check exists for makes the route 404, and an error body has no entry by that
  # name either — so the sentinel form passed while the delete was broken, which
  # is an assertion with two ways to pass. Four entries go in, three come back,
  # and a 404 body answers neither.
  equals "the HOST surface removes a payment too"         "$(json_field "$HOSTGONE" budget.expenses.length)" "3"
  contains "...putting the debt back where it was"        "$HOSTGONE" '"email":"ben@e.com","paidCents":15968,"owedCents":19161,"netCents":-3193'
  equals "...and the plan asks for it again"              \
    "$(json_field "$HOSTGONE" budget.settlements.0.fromName)>$(json_field "$HOSTGONE" budget.settlements.0.toName):$(json_field "$HOSTGONE" budget.settlements.0.amountCents)" \
    "Ben>Ana:3193"

  # A `logistics` PLANNER MAY NOT MOVE MONEY, executed rather than grepped. The
  # gate is shared with the expense writes precisely so the two cannot disagree
  # about this role (#48 shipped that bug once), and until now the only 403 here
  # came from an account with no standing at all — a different question.
  if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
    LOGTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$STRIP/planner-invites" -d '{"role":"logistics"}' \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    # The acceptance is asserted, because a 403 from an invite that never landed
    # would be the "no standing" check again wearing this one's name.
    contains "a second account really is a logistics planner" \
      "$(body -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" -X POST "$BASE/api/host/join/$LOGTOK/accept")" '"role":"logistics"'
    check "...and a logistics planner may not record a payment" 403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" "${JSON[@]}" \
      -X POST "$SETTLE" -d "$PAY"
    check "...nor remove one"                                   403 -H "Cookie: $ZAEME_TEST_GUEST_COOKIE" \
      -X DELETE "$SETTLE/$CHALET_ID"
  else
    echo "  skip  set ZAEME_TEST_GUEST_COOKIE to a second session to run the logistics checks"
  fi
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

echo
echo "== the receipt on an expense (Bermos/zaeme#29) =="
# "What was that 84 francs?" — and the answer is a photo somebody already took.
#
# A FILE UPLOAD HAS ITS OWN SPECIES OF LIE, and a 200 is the whole of it. What
# is asserted below is what is actually STORED and what is actually SERVED: the
# bytes fetched back through the signed URL are hashed and compared to the
# bytes that went up, and the content type they come back with is read off the
# response rather than assumed from the request. Nothing here trusts a status
# code to mean a photograph exists.
#
# AND WHAT THE PIN MUST NOT DO. A receipt is the strongest evidence a budget can
# carry, which makes it exactly the thing that must not quietly relabel a row:
# `fxRateSource: 'manual'` means a PERSON stated a figure and checked it against
# a statement (#59, #71), and a photograph is not a person saying anything. So
# the money on the entry is captured BEFORE the pin and compared to itself
# afterwards — there is no literal to write down, because a literal here would
# be a constant standing in for "unchanged" and would pass just as happily
# against an implementation that rewrote the row to the same defaults.
#
# Both directions are covered: a `manual` EUR entry with a stated pair (where a
# relabel would DOWNGRADE it and lose the figure) and a `fetched` CHF one (where
# a relabel would UPGRADE it into a claim nobody made).
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ] && [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  ROWNER=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  RGUEST=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")

  # Its own trip: everything above leaves events in states this block would have
  # to work around, and an invite token only resolves on a live one.
  RSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke receipt $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$RSLUG/status" -d '{"status":"published"}' > /dev/null
  RTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$RSLUG/invites" -d '{"label":"Receipt smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  RMEEXP="$BASE/api/me/events/$RSLUG/expenses"
  RMEDIA="$BASE/api/me/events/$RSLUG/media"
  echo "  trip: $RSLUG"

  # EUR 84.00 that cost the payer CHF 80.00 — `manual`, with the stated pair
  # recorded. Lopsided on purpose: none of these figures is a default, so a row
  # rewritten to defaults is visibly a different string.
  RDIN=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEEXP" \
    -d '{"title":"Dinner","amountCents":8400,"currency":"EUR","targetAmountCents":8000,"paidByName":"A","paidByEmail":"a@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
  RDIN_ID=$(expense_id "$RDIN" "Dinner")
  contains "an entry somebody checked against a statement" "$RDIN" '"fxRateSource":"manual"'
  RTRAM=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEEXP" \
    -d '{"title":"Tram tickets","amountCents":1230,"paidByName":"B","paidByEmail":"b@e.com","participants":[{"name":"A","email":"a@e.com"},{"name":"B","email":"b@e.com"}]}')
  RTRAM_ID=$(expense_id "$RTRAM" "Tram tickets")

  # --- who may pin. Needs no object storage: every gate runs before the lookup.
  check "an anonymous pin is refused"              401 "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d '{"mediaId":"nope"}'
  check "...and so is an anonymous UNpin"          401 -X DELETE "$RMEEXP/$RDIN_ID/receipt"
  check "a service token is not an account here"   401 "${AUTH[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d '{"mediaId":"nope"}'
  check "an account with no standing on the trip"  403 "${RGUEST[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d '{"mediaId":"nope"}'
  check "...cannot take one off either"            403 "${RGUEST[@]}" -X DELETE "$RMEEXP/$RDIN_ID/receipt"
  check "the invite link never gained a pin route" 404 "${JSON[@]}" -X PUT "$BASE/api/invites/$RTOK/expenses/$RDIN_ID/receipt" -d '{"mediaId":"nope"}'
  check "an anonymous participant upload is refused" 401 "${JSON[@]}" -X POST "$RMEDIA/presign" -d '{"type":"photo","fileName":"r.png","mimeType":"image/png","sizeBytes":10}'
  check "...and a non-participant's is 403"        403 "${RGUEST[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" -d '{"type":"photo","fileName":"r.png","mimeType":"image/png","sizeBytes":10}'

  # --- the bytes. These need a bucket, and skip as ONE line without one,
  #     exactly like the poster checks at the bottom of this file. CI always has
  #     `adobe/s3mock`, and the job fails on any `skip` at all.
  if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
    RIMG=$(mktemp); printf '\x89PNG\r\n\x1a\n' > "$RIMG"; head -c 700 /dev/urandom >> "$RIMG"
    RSHA=$(sha256sum "$RIMG" | cut -d' ' -f1)
    RSIZE=$(wc -c < "$RIMG" | tr -d ' ')

    # THE BODY `BudgetCard.vue` COMPOSES, field for field — `type: 'photo'` and
    # the three facts about the file, and nothing else. The smoke script writes
    # its own bodies everywhere else in this file, which is precisely how the
    # form shipped a shape the server never saw twice (#27, #71).
    RPRE=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d "{\"type\":\"photo\",\"fileName\":\"receipt.png\",\"mimeType\":\"image/png\",\"sizeBytes\":$RSIZE}")
    RMID=$(json_field "$RPRE" mediaId)
    RPUT=$(json_field "$RPRE" upload.url)
    contains "a participant may register a gallery photo" "$RPRE" '"mediaId"'
    contains "...with an upload URL that is SIGNED"       "$RPUT" 'X-Amz-Signature='
    contains "...and one that EXPIRES"                    "$RPUT" 'X-Amz-Expires=900'

    # Pinning a `pending` row is refused: an upload that never lands must not
    # leave an expense pointing at bytes that are not there.
    check "a pin before the upload is confirmed"     409 "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d "{\"mediaId\":\"$RMID\"}"

    check "the browser PUTs the bytes itself"        200 -X PUT -H 'content-type: image/png' --data-binary "@$RIMG" "$RPUT"
    check "...which a non-participant cannot confirm" 403 "${RGUEST[@]}" "${JSON[@]}" -X POST "$RMEDIA/confirm" -d "{\"mediaId\":\"$RMID\"}"
    check "confirming the upload marks it ready"     200 "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/confirm" -d "{\"mediaId\":\"$RMID\"}"

    RPIN=$(body "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d "{\"mediaId\":\"$RMID\"}")
    equals "the expense now carries that photo"      "$(receipt_of "$RPIN" Dinner id)" "$RMID"
    RURL=$(receipt_of "$RPIN" Dinner url)
    contains "...behind a signed, expiring URL"      "$RURL" 'X-Amz-Signature='
    contains "...that is not stored anywhere"        "$RURL" 'X-Amz-Expires=3600'

    # WHAT IS ACTUALLY STORED AND WHAT IS ACTUALLY SERVED. A 200 on the upload
    # says a request was accepted; only the digest says the right bytes came
    # back, and only the response header says they come back as a picture rather
    # than as a download of unknown type. (s3mock does not verify the signature
    # it is handed, so the two checks above are about the URL's SHAPE; this pair
    # is about the object.)
    equals "the bytes served are the bytes uploaded" "$(curl -s "$RURL" | sha256sum | cut -d' ' -f1)" "$RSHA"
    contains "...served as the type they went up as" "$(curl -sI "$RURL" | tr 'A-Z' 'a-z')" 'content-type: image/png'

    # THE ASSERTION THIS BLOCK EXISTS FOR. No literal: the money the entry states
    # about itself, before the pin and after it, compared to itself.
    equals "pinning a receipt moves no money and relabels nothing" \
      "$(money_of "$RPIN" Dinner)" "$(money_of "$RDIN" Dinner)"
    contains "...and the checked figure is still there to compare" "$RPIN" '"fxRateSource":"manual","statedAmountCents":8000,"statedCurrency":"CHF"'

    # The other direction: a `fetched` row must not be UPGRADED into a claim.
    RPRE2=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d "{\"type\":\"photo\",\"fileName\":\"tram.png\",\"mimeType\":\"image/png\",\"sizeBytes\":$RSIZE}")
    RMID2=$(json_field "$RPRE2" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: image/png' --data-binary "@$RIMG" "$(json_field "$RPRE2" upload.url)"
    body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/confirm" -d "{\"mediaId\":\"$RMID2\"}" > /dev/null
    RPIN2=$(body "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RTRAM_ID/receipt" -d "{\"mediaId\":\"$RMID2\"}")
    equals "...nor does it upgrade an unchecked one"  "$(money_of "$RPIN2" 'Tram tickets')" "$(money_of "$RTRAM" 'Tram tickets')"
    contains "...which still says nobody checked it"  "$RPIN2" '"fxRateSource":"fetched","statedAmountCents":null,"statedCurrency":null'

    # WHO MAY READ IT. The budget over the invite link carries the thumbnail,
    # because the population holding that link could already fetch the same
    # object from `GET /api/invites/{token}/media` — pinning widens nothing.
    RIBUD=$(body "$BASE/api/invites/$RTOK/budget")
    equals "the invite link sees the same receipt"   "$(receipt_of "$RIBUD" Dinner id)" "$RMID"
    contains "...also behind a signed URL, not a key" "$(receipt_of "$RIBUD" Dinner url)" 'X-Amz-Signature='
    check "a token that is not a token sees nothing" 404 "$BASE/api/invites/not-a-real-token-at-all/budget"
    # AND THE PAGE RESOLVE, which is the one that was actually wrong. `GET
    # /api/invites/{token}` is one line — `return getInvitePage(token)` — and the
    # budget is nested three levels down inside what it answers, so it carried
    # every receipt as a bare storage key with no URL at all while the budget
    # refresh beside it signed them correctly. SSR renders the guest page off
    # THIS route, so that was every thumbnail on the screen somebody opens.
    RIPAGE=$(body "$BASE/api/invites/$RTOK")
    equals "the guest page resolve carries it too"  "$(receipt_of "$RIPAGE" Dinner id)" "$RMID"
    contains "...signed there as well, not a key"   "$(receipt_of "$RIPAGE" Dinner url)" 'X-Amz-Signature='

    # …and the MACHINE surface does not. No download URL crosses that boundary,
    # which `listMedia` has always said; a budget is not an exception to it.
    RV1BUD=$(body "${AUTH[@]}" "$API/events/$RSLUG/budget")
    contains "the machine budget still has the entry" "$RV1BUD" '"title":"Dinner"'
    excludes "...and no receipt object on it"         "$RV1BUD" '"receipt"'
    excludes "...and no signed URL anywhere in it"    "$RV1BUD" 'X-Amz-Signature'
    # What DOES cross, and it is an id: listMedia says which expense an item is
    # the receipt for.
    RV1MED=$(body "${AUTH[@]}" "$API/events/$RSLUG/media")
    equals "listMedia names the expense it belongs to" "$(media_field "$RV1MED" "$RMID" expenseId)" "$RDIN_ID"
    excludes "...still with no URL for the bytes"      "$RV1MED" '"url"'

    # REPLACING. One expense, one receipt: pinning a second un-pins the first,
    # and the first stays in the gallery.
    RPRE3=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d "{\"type\":\"photo\",\"fileName\":\"better.png\",\"mimeType\":\"image/png\",\"sizeBytes\":$RSIZE}")
    RMID3=$(json_field "$RPRE3" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: image/png' --data-binary "@$RIMG" "$(json_field "$RPRE3" upload.url)"
    body "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/confirm" -d "{\"mediaId\":\"$RMID3\"}" > /dev/null
    RREP=$(body "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d "{\"mediaId\":\"$RMID3\"}")
    equals "a second pin replaces the first"         "$(receipt_of "$RREP" Dinner id)" "$RMID3"
    RV1MED2=$(body "${AUTH[@]}" "$API/events/$RSLUG/media")
    equals "...un-pinning the one it replaced"       "$(media_field "$RV1MED2" "$RMID" expenseId)" "null"
    equals "...which is still in the gallery"        "$(media_field "$RV1MED2" "$RMID" id)" "$RMID"
    equals "...and the money STILL has not moved"    "$(money_of "$RREP" Dinner)" "$(money_of "$RDIN" Dinner)"

    # WHAT MAY BE A RECEIPT. A ticket belongs to one attendee; the budget is read
    # by the whole event, so pinning one would publish it through a side door.
    RTPRE=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$RSLUG/media/presign" \
      -d '{"type":"ticket","fileName":"seat.pdf","mimeType":"application/pdf","sizeBytes":64}')
    RTID=$(json_field "$RTPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: application/pdf' --data-binary 'not-really-a-pdf-but-64-bytes-long-enough-for-this-smoke-check!' \
      "$(json_field "$RTPRE" upload.url)"
    body "${ROWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$RSLUG/media/confirm" -d "{\"mediaId\":\"$RTID\"}" > /dev/null
    check "a ticket may not be a receipt"            422 "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RTRAM_ID/receipt" -d "{\"mediaId\":\"$RTID\"}"
    contains "...and says why, in words"             "$(body "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RTRAM_ID/receipt" -d "{\"mediaId\":\"$RTID\"}")" 'belongs to one person'
    # A REAL id from a REAL other trip, not a made-up string. The two are the
    # same 404 today and would stop being the same the moment somebody dropped
    # the `eventId` half of the lookup — at which point a made-up id would still
    # 404 and this check would still pass while a friend's photograph could be
    # pinned to a stranger's dinner. The owner plans both trips, so the gate
    # lets this request through and only the scoping refuses it.
    RSLUG2=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
      -d "{\"title\":\"Smoke receipt other $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
    body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$RSLUG2/status" -d '{"status":"published"}' > /dev/null
    ROPRE=$(body "${ROWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$RSLUG2/media/presign" \
      -d "{\"type\":\"photo\",\"fileName\":\"elsewhere.png\",\"mimeType\":\"image/png\",\"sizeBytes\":$RSIZE}")
    ROMID=$(json_field "$ROPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: image/png' --data-binary "@$RIMG" "$(json_field "$ROPRE" upload.url)"
    body "${ROWNER[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$RSLUG2/media/confirm" -d "{\"mediaId\":\"$ROMID\"}" > /dev/null
    check "a real photo from ANOTHER trip is not found" 404 "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d "{\"mediaId\":\"$ROMID\"}"
    check "...and the same in reverse"                  404 "${ROWNER[@]}" "${JSON[@]}" -X PUT "$BASE/api/me/events/$RSLUG2/expenses/$RDIN_ID/receipt" -d "{\"mediaId\":\"$ROMID\"}"

    # THE SIZE AND TYPE LIMITS, at them. `image/*` up to 25 MB.
    check "a photo over the 25 MB limit"             413 "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d '{"type":"photo","fileName":"huge.png","mimeType":"image/png","sizeBytes":26214401}'
    check "...and one that is not an image at all"   422 "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d '{"type":"photo","fileName":"r.pdf","mimeType":"application/pdf","sizeBytes":1024}'
    check "the papers stay host-managed here"        400 "${ROWNER[@]}" "${JSON[@]}" -X POST "$RMEDIA/presign" \
      -d '{"type":"document","fileName":"r.pdf","mimeType":"application/pdf","sizeBytes":1024}'

    # DELETING THE PHOTO leaves the expense intact — the row goes, the entry does
    # not, and the receipt simply reads as absent.
    check "a planner deletes the pinned photo"       200 "${ROWNER[@]}" -X DELETE "$BASE/api/host/events/$RSLUG/media/$RMID3"
    RGONE=$(body "$BASE/api/invites/$RTOK/budget")
    contains "the expense survives it"               "$RGONE" '"title":"Dinner"'
    equals "...with no receipt on it"                "$(receipt_of "$RGONE" Dinner id)" "none"
    equals "...and its money untouched"              "$(money_of "$RGONE" Dinner)" "$(money_of "$RDIN" Dinner)"

    # DELETING THE EXPENSE leaves the photo in the gallery — `on delete set null`
    # un-pins it rather than taking it with it.
    check "the expense with the OTHER receipt goes"  200 "${ROWNER[@]}" -X DELETE "$RMEEXP/$RTRAM_ID"
    RV1MED3=$(body "${AUTH[@]}" "$API/events/$RSLUG/media")
    equals "its photo is still in the gallery"       "$(media_field "$RV1MED3" "$RMID2" id)" "$RMID2"
    equals "...un-pinned rather than deleted"        "$(media_field "$RV1MED3" "$RMID2" expenseId)" "null"

    # UN-PINNING BY HAND says the same thing, and is idempotent: "there is no
    # receipt" is the state the caller asked for.
    RUP=$(body "${ROWNER[@]}" "${JSON[@]}" -X PUT "$RMEEXP/$RDIN_ID/receipt" -d "{\"mediaId\":\"$RMID\"}")
    equals "a photo can be pinned again afterwards"  "$(receipt_of "$RUP" Dinner id)" "$RMID"
    RUNP=$(body "${ROWNER[@]}" -X DELETE "$RMEEXP/$RDIN_ID/receipt")
    equals "...and taken off again"                  "$(receipt_of "$RUNP" Dinner id)" "none"
    check "...twice, without complaining"            200 "${ROWNER[@]}" -X DELETE "$RMEEXP/$RDIN_ID/receipt"
    RSTILL=$(body "${AUTH[@]}" "$API/events/$RSLUG/media")
    equals "the photo is STILL in the gallery"       "$(media_field "$RSTILL" "$RMID" id)" "$RMID"

    rm -f "$RIMG"
  else
    echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run the receipt bytes"
  fi
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
  # THE ZONE A GEOCODED PLACE OFFERS (#31). `addressdetails=1` is asked for so
  # that a result can carry the country it landed in, and the zones of that
  # country are derived from ICU on the way out — which is how a host who does
  # not know that Lisbon is spelled `Europe/Lisbon` gets offered it. Asserted as
  # a verdict about the rule rather than about Portugal, for the reason the
  # whole section gives: no check here may need Nominatim to answer.
  equals "...offering the zones of the country it is in" "$(geocode_zones "$S1")" "well-zoned"
  # EVERY ZONE, NOT THE FIRST FEW. The card shipped `.slice(0, 4)` of an
  # ALPHABETICAL list; Portugal has exactly three and fits, which is why the
  # stub, both fixtures and every check here were blind to it. The stub now also
  # knows a place in a country with twenty-nine, and this asserts the two a pin
  # in Brooklyn must be offered — one of which, `America/Los_Angeles`,
  # alphabetically sorts far below the four that used to be shown.
  US1=$(body "${PLN32[@]}" --get --data-urlencode "q=brooklyn bridge $SUFFIX" "$HSEARCH")
  equals "a country with many zones is well-zoned too" "$(geocode_zones "$US1")" "well-zoned"
  ZCOUNT=$(zone_count "$US1")
  equals "...and the offer is not truncated to four" "$ZCOUNT" "29"
  contains "...so a pin in Brooklyn is offered New York"  "$US1" '"America/New_York"'
  contains "...and Los Angeles, which sorts below the old cut" "$US1" '"America/Los_Angeles"'

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
  equals "...and a named pin offers a zone too (#31)" "$(geocode_zones "$R1")" "well-zoned"

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
echo "== an event abroad shows its itinerary in its own zone (Bermos/zaeme#31) =="
# WHAT IS EXECUTED HERE, and why none of it is decidable from the source.
#
# `events_event.timezone` is a DISPLAY label: what it must never do is move a
# stored instant, and "we did not write a conversion" is a claim about today's
# code rather than about the database. So the itinerary's departure is written
# BEFORE the zone is set and read back AFTER — twice, on two surfaces, against
# the value it was written with rather than against a constant. A refactor that
# "helpfully" rebased the stored times onto the new zone reddens here and
# nowhere else in this repository.
#
# The rest is the validation's PERMIT SET, which is the half a refusal test
# usually misses: `Intl.DateTimeFormat` accepts `+01:00`, `Etc/GMT+5` and `UTC`,
# and every one of them reads correctly in March and an hour wrong in April. A
# unit test proves the rule; this proves the ROUTE applies it, on the surface a
# person actually uses — the host session, where `BudgetCard`'s lesson applies:
# proving it on `/api/v1` would prove nothing about the screen, and in this case
# `/api/v1` deliberately does not take the field at all.
TZTRIP=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke abroad $SUFFIX\",\"type\":\"trip\"}")
TZSLUG=$(printf '%s' "$TZTRIP" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
TZHOST="$BASE/api/host/events/$TZSLUG"
echo "  trip: $TZSLUG"

# A trip planned with no zone HAS no zone — null, not the instance's clock and
# not the server's. Read off the machine surface, which is where the field is
# reported: the create response carries only an id and a slug.
contains "a new trip has no zone at all"         "$(body "${AUTH[@]}" "$API/events/$TZSLUG")" '"timezone":null'
# A DISPLAY ZONE IS NOT A CREDENTIAL AND NOT A MACHINE FIELD. Setting one is
# the host's screen, which is the decision the read-only `/api/v1` shape
# records; a body carrying it is refused by the strict schema rather than
# silently ignored, which is the difference between "not offered" and "accepted
# and dropped".
check "setting a zone needs a session"           401 "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"Europe/Lisbon"}'
check "...and a service token is not one"        401 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"Europe/Lisbon"}'
check "the machine API does not take a zone"     422 "${AUTH[@]}" "${JSON[@]}" -X PATCH "$API/events/$TZSLUG" -d '{"timezone":"Europe/Lisbon"}'
check "...nor on the way in"                     422 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Zoned at birth $SUFFIX\",\"timezone\":\"Europe/Lisbon\"}"

if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  TZP=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")

  # The 09:14 out of Lisbon, written as the instant it is. This is the value
  # every assertion below compares against — never a constant, so a migration or
  # a refactor that shifted it by an hour cannot agree with the expectation.
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TZSLUG/timeline" \
    -d '{"title":"The early ferry west","startsAt":"2027-07-01T08:14:00Z","type":"transport"}' > /dev/null
  TZBEFORE=$(tl_start "$(body "${AUTH[@]}" "$API/events/$TZSLUG/timeline")" "The early ferry west")
  # THE ANTI-VACUITY GUARD, and the only literal in this block. Every comparison
  # below is against `$TZBEFORE`; if the helper found nothing it would answer a
  # sentinel both times and "the instant did not move" would be two sentinels
  # agreeing with each other. This is the line that says the fixture is there,
  # and is the instant it was written as.
  equals "the itinerary has a departure to watch" "$TZBEFORE" "2027-07-01T08:14:00.000Z"

  SET=$(body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"Europe/Lisbon"}')
  contains "a planner sets the trip's zone"           "$SET" '"timezone":"Europe/Lisbon"'
  contains "...and the host aggregate reports it"     "$(body "${TZP[@]}" "$TZHOST")" '"timezone":"Europe/Lisbon"'
  contains "...as does the machine API, read-only"    "$(body "${AUTH[@]}" "$API/events/$TZSLUG")" '"timezone":"Europe/Lisbon"'

  # THE BOUNDARY THE ISSUE DRAWS IN TERMS: storage does not change. Compared
  # against what was written above, on the machine surface and again on the
  # human one, because the two read through different projections.
  equals "setting a zone moves no stored instant" \
    "$(tl_start "$(body "${AUTH[@]}" "$API/events/$TZSLUG/timeline")" "The early ferry west")" "$TZBEFORE"
  equals "...on the host surface either"          \
    "$(tl_start "$(body "${TZP[@]}" "$TZHOST")" "The early ferry west")" "$TZBEFORE"

  # The guest is who this is for: an invite link is what gets forwarded, and it
  # is SSR'd, so the zone has to reach the page that renders the departure.
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TZSLUG/status" -d '{"status":"published"}' > /dev/null
  TZTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TZSLUG/invites" -d '{"label":"Zone smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  TZINVITE=$(body "$BASE/api/invites/$TZTOK")
  contains "the invite link carries the zone"         "$TZINVITE" '"timezone":"Europe/Lisbon"'
  equals "...and the departure on it is untouched"    "$(tl_start "$TZINVITE" "The early ferry west")" "$TZBEFORE"

  # THE RENDER, AND NOT ONLY THE FIELD. Everything above proves the zone is
  # stored and reported; none of it would go red if every screen went on
  # formatting against the reader's clock, because JSON carries an instant and
  # not a rendering. The invite page is SSR'd — that is the whole reason the
  # zone exists, since a forwarded link has to say the right time in the HTML
  # before any JavaScript runs — so the rendered page is fetched and read.
  #
  # The fixture item is called "The early ferry west" ON PURPOSE. It used to be
  # "The 09:14 to Lisbon", which put the asserted time in the TITLE: the needle
  # would have matched its own sibling and passed with the rendering dropped.
  #
  # `08:14` is the same instant read against this server's own clock, and its
  # absence is what says the page is not quietly rendering in the container's
  # zone. That half is only DISCRIMINATING on a server that is not itself in
  # Europe/Lisbon (CI is UTC); the zone note above it is discriminating
  # everywhere, because a page rendering in its own clock never names another.
  #
  # BOTH TIME NEEDLES ARE ANCHORED ON THE ELEMENT BOUNDARIES (`>09:14<`), and
  # that is not fussiness: Nuxt serialises the whole payload into
  # `__NUXT_DATA__` on the same page, so the raw instant
  # `2027-07-01T08:14:00.000Z` is in the HTML by construction and a bare
  # `excludes '08:14'` fails against a perfectly correct render. It did, which
  # is how this note came to be written.
  TZHTML=$(body "$BASE/i/$TZTOK")
  contains "the SSR'd invite page names the clock"    "$TZHTML" 'Times are in Europe/Lisbon'
  contains "...and renders the ferry at 09:14 there"  "$TZHTML" '>09:14<'
  excludes "...not at this server's own 08:14"        "$TZHTML" '>08:14<'

  # CASE IS FOLDED, AN ALIAS IS NOT. A host who types it in lower case gets the
  # spelling back that every screen will then show.
  contains "a lower-case zone comes back canonical"   "$(body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"europe/lisbon"}')" '"timezone":"Europe/Lisbon"'

  # THE PERMIT SET. Every one of these is accepted by `Intl.DateTimeFormat` and
  # refused here, and the reason is the third acceptance criterion: a fixed
  # offset cannot follow a daylight-saving change, so a trip labelled `+01:00`
  # is right in March and an hour wrong in April with nothing saying so.
  #
  # 422 AND NOT 400 IS THE POINT. The route's schema bounds the length and
  # nothing else, so a 400 here would mean zod refused it and the domain rule
  # was never consulted — which is a different finding and the same colour.
  check "a fixed offset is not a time zone"       422 "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"+01:00"}'
  check "...nor is the Etc area that spells one"  422 "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"Etc/GMT+5"}'
  check "...nor UTC"                              422 "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"UTC"}'
  check "...nor a region that does not exist"     422 "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"America/Nowhere"}'
  contains "...and the refusal says what one looks like" \
    "$(body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"America/Nowhere"}')" 'Use a region name like Europe/Lisbon'
  # A REFUSAL WRITES NOTHING. Four 422s in a row must leave the trip exactly as
  # it was; a handler that assigned before validating would leave it on the last
  # thing anybody typed.
  contains "four refusals later the zone is untouched" "$(body "${TZP[@]}" "$TZHOST")" '"timezone":"Europe/Lisbon"'

  # CLEARING IT IS A VALUE, NOT A MISTAKE — it is what every event had before
  # this column and what a host who wants the reader's own clock is asking for.
  # It must not arrive as the 422 above.
  CLEARED=$(body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":null}')
  contains "clearing the zone is allowed"             "$CLEARED" '"timezone":null'
  contains "...and an empty string means the same"    "$(body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":""}')" '"timezone":null'
  # AGAINST THE LITERAL, not against `$TZBEFORE`. A rebase that is SYMMETRIC —
  # shift on set, shift back on clear — has already undone itself by the time
  # this samples, so comparing to a baseline the same mutation could have moved
  # is a check that cannot fail on the mutation it is written for. The literal
  # is the instant the fixture was written at, and the `equals` above pins
  # `$TZBEFORE` to it, so the two together cover both directions.
  equals "...and clearing it moves no instant either" \
    "$(tl_start "$(body "${AUTH[@]}" "$API/events/$TZSLUG/timeline")" "The early ferry west")" "2027-07-01T08:14:00.000Z"
  # Absent is not null: a PATCH about something else must not clear the zone.
  body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"timezone":"Pacific/Chatham"}' > /dev/null
  body "${TZP[@]}" "${JSON[@]}" -X PATCH "$TZHOST" -d '{"location":"Cais do Sodre"}' > /dev/null
  contains "a PATCH about something else keeps it"    "$(body "${TZP[@]}" "$TZHOST")" '"timezone":"Pacific/Chatham"'

  # THE DATE POLL, ON THE LINK THAT GOES IN THE GROUP CHAT.
  #
  # This is the surface #31 shipped wrong and no check here could see: the smoke
  # fixture was a TRIP WITH A TIMELINE ITEM, so the poll card was executed by
  # nothing. The host page reads candidates against the event's clock and writes
  # them there, so a host in Zürich planning a Lisbon party types 20:00 and
  # `isoFromZonedInput` stores the right instant — while `DatePoll.vue` rendered
  # it in the READER's zone with no label anywhere on the card. One event, two
  # clocks, and the wrong one on the forwarded link. The poll's winner also
  # becomes the event's own `startsAt` when the host locks it.
  #
  # 17:30Z is 18:30 in Lisbon and 17:30 on this runner's own clock, and the
  # needles are anchored on element boundaries for the `__NUXT_DATA__` reason
  # given above.
  TZPARTY=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/parties" \
    -d "{\"title\":\"Smoke party abroad $SUFFIX\",\"coreInvites\":[{\"name\":\"Ana\"}],\"dateOptions\":[{\"startsAt\":\"2027-07-01T17:30:00Z\"}]}")
  TZPSLUG=$(printf '%s' "$TZPARTY" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  TZPTOK=$(printf '%s' "$TZPARTY" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  body "${TZP[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$TZPSLUG" -d '{"timezone":"Europe/Lisbon"}' > /dev/null
  TZPHTML=$(body "$BASE/i/$TZPTOK")
  contains "the poll card names the clock it is showing" "$TZPHTML" 'Times are in Europe/Lisbon'
  contains "...and offers the candidate at 18:30 there" "$TZPHTML" '>Thu, 1 Jul, 18:30<'
  excludes "...not at this server's own 17:30"          "$TZPHTML" '>Thu, 1 Jul, 17:30<'

  # A SHOWING INHERITS ITS SERIES' CLOCK, which is a decision taken on the
  # owner's behalf and is executed here because nothing else can see it: a
  # showing is a separate event row, written by `scheduleOccurrence` in the same
  # breath as the description, the location and the currency it already
  # inherited. Without this the container's page would list the showtime in the
  # series' clock while the showing's own invite link rendered the same instant
  # in the reader's — one screen contradicting the other about one evening.
  TZSER=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke cinema abroad $SUFFIX\",\"type\":\"series\"}")
  TZSERSLUG=$(printf '%s' "$TZSER" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${TZP[@]}" "${JSON[@]}" -X PATCH "$BASE/api/host/events/$TZSERSLUG" -d '{"timezone":"Europe/Lisbon"}' > /dev/null
  TZSHOW=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TZSERSLUG/series/showings" \
    -d '{"title":"Fados","startsAt":"2027-07-08T19:00:00+01:00"}')
  contains "a showing inherits the series' clock"     "$TZSHOW" '"timezone":"Europe/Lisbon"'
  # …and a series with NO zone still mints showings with none, which is the half
  # that says this is inheritance and not a default somebody reached for.
  TZSER2=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" -d "{\"title\":\"Smoke cinema at home $SUFFIX\",\"type\":\"series\"}")
  TZSERSLUG2=$(printf '%s' "$TZSER2" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  contains "...and a zoneless series mints zoneless ones" \
    "$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TZSERSLUG2/series/showings" -d '{"title":"Heat","startsAt":"2027-07-09T20:00:00+02:00"}')" '"timezone":null'
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to the planner's session to run these"
fi

echo
echo "== what a ticket says (Bermos/zaeme#35) =="
# A ticket was a PDF with a filename. At a barrier you need the booking
# reference and the seat BEFORE the PDF finishes rendering — or, on a train with
# no signal, when it never does — so the facts are rows in `events_ticket_detail`
# and they travel beside the download.
#
# WHAT ONLY A DATABASE CAN SHOW. The table is new, its foreign key is composite,
# and its cascade runs in Postgres and nowhere else: `pnpm test` reads the
# schema file and executes no SQL at all, so the upsert, the scoping to one
# event and the delete that takes the detail with the ticket are proved here or
# by nothing.
#
# THE ONE THING THIS BLOCK CANNOT SEE is the rendering. The ticket list is
# fetched by the browser (media URLs are short-lived signatures, so
# `app/pages/i/[token].vue` loads them `onMounted`), which means there is no
# SSR'd HTML with a seat number in it to read the way the #31 checks above read
# the itinerary. That half lives in `test/ticket-detail.test.ts`, over the pure
# function the cards call — which is the same remedy #31's review reached for
# when a zone shortlist was wrong in a card the wire could not see.
#
# WHAT IS ASSERTED HERE INSTEAD is the half JSON can carry, and the instants are
# most of it: `valid_from`/`valid_until` are `timestamptz`, so setting the trip's
# zone and clearing it again must move neither, compared against the literal
# they were written as rather than against a baseline the same mutation could
# have moved.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ] && [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
  TDP=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  TDG=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")

  # Its own trip, published so an invite token resolves on it, and its own
  # invite: this script re-runs against the previous run's rows.
  TDSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke ticket $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TDSLUG/status" -d '{"status":"published"}' > /dev/null
  TDTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TDSLUG/invites" -d '{"label":"Ticket smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  TDHOST="$BASE/api/host/events/$TDSLUG"
  echo "  trip: $TDSLUG"

  # --- WHO MAY WRITE ONE. Needs no object storage: every credential gate runs
  #     before the media row is ever looked up, so these run on a bare instance.
  check "an anonymous ticket detail is refused"     401 "${JSON[@]}" -X PUT "$TDHOST/media/nope/detail" -d '{"seat":"41A"}'
  check "a service token is not a planner here"     401 "${AUTH[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/nope/detail" -d '{"seat":"41A"}'
  check "an account with no standing on the trip"   403 "${TDG[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/nope/detail" -d '{"seat":"41A"}'
  check "the invite link never gained the route"    404 "${JSON[@]}" -X PUT "$BASE/api/invites/$TDTOK/media/nope/detail" -d '{"seat":"41A"}'
  check "...nor did the machine API"                404 "${AUTH[@]}" "${JSON[@]}" -X PUT "$API/events/$TDSLUG/media/nope/detail" -d '{"seat":"41A"}'
  check "...nor the account surface"                404 "${TDP[@]}" "${JSON[@]}" -X PUT "$BASE/api/me/events/$TDSLUG/media/nope/detail" -d '{"seat":"41A"}'
  # A PLANNER naming a ticket that does not exist gets a 404 rather than a 403:
  # this is the line that says the three above are about the CREDENTIAL and not
  # about the made-up media id they all carry.
  check "a planner with no such ticket gets a 404"  404 "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/nope/detail" -d '{"seat":"41A"}'

  # ASK WHAT THE GUARD PERMITS, NOT WHAT IT FORBIDS (#74). `logistics` is a real
  # planner row, and it is the one role `assertPlanner(roles: [owner,
  # co_planner])` exists to keep out — so the 403 above, from an account with no
  # standing at all, is a different question from this one. The acceptance is
  # asserted first, or a 403 from an invite that never landed would be the "no
  # standing" check wearing this one's name.
  TDLOG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TDSLUG/planner-invites" -d '{"role":"logistics"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  contains "a second account really is a logistics planner" \
    "$(body "${TDG[@]}" "${JSON[@]}" -X POST "$BASE/api/host/join/$TDLOG/accept")" '"role":"logistics"'
  check "...and a logistics planner may not annotate" 403 "${TDG[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/nope/detail" -d '{"seat":"41A"}'

  # --- THE ROWS THEMSELVES. These need a bucket, because there is no ticket
  #     without an upload, and skip as ONE line without one — exactly like the
  #     receipt bytes and the poster checks. CI always has `adobe/s3mock`, and
  #     the job fails on any `skip` at all.
  if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
    TDPDF='%PDF-1.4 not really a pdf, but bytes enough for a smoke check.'
    TDSIZE=${#TDPDF}
    TDPRE=$(body "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/presign" \
      -d "{\"type\":\"ticket\",\"fileName\":\"lisbon.pdf\",\"mimeType\":\"application/pdf\",\"sizeBytes\":$TDSIZE}")
    TDMID=$(json_field "$TDPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: application/pdf' --data-binary "$TDPDF" "$(json_field "$TDPRE" upload.url)"
    check "a planner uploads a ticket"              200 "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/confirm" -d "{\"mediaId\":\"$TDMID\"}"

    # ACCEPTANCE 1: A TICKET WITH NO DETAIL ROW READS EXACTLY AS IT DID TODAY.
    # `no-such-item` and `no-detail` are different answers from this helper, so
    # the first line is not satisfied by a ticket that vanished from the list.
    TDV1=$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")
    equals "the fresh ticket is in the list"        "$(media_field "$TDV1" "$TDMID" id)" "$TDMID"
    equals "...and reports NO detail at all"        "$(ticket_field "$TDV1" "$TDMID" seat)" "no-detail"
    contains "...as an explicit null, not a gap"    "$TDV1" '"ticket":null'
    equals "...on the host surface too"             "$(ticket_field "$(body "${TDP[@]}" "$TDHOST/media")" "$TDMID" seat)" "no-detail"

    # ACCEPTANCE 2: A PLANNER WRITES THEM AFTER THE UPLOAD. Lopsided values on
    # purpose — none of them is a default, so a handler that discarded its input
    # and answered its own defaults is visibly a different string.
    TDSET=$(body "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDMID/detail" \
      -d '{"carrier":"SBB","bookingRef":"XY7Q2M","coach":"12","seat":"41A","travellerName":"Ana Silva","validFrom":"2026-07-01T07:00:00Z","validUntil":"2026-07-01T22:59:00Z","note":"Window, facing forwards"}')
    equals "a planner writes the seat after upload" "$(ticket_field "$TDSET" "$TDMID" seat)" "41A"
    equals "...and the coach"                       "$(ticket_field "$TDSET" "$TDMID" coach)" "12"
    equals "...and the booking reference"           "$(ticket_field "$TDSET" "$TDMID" bookingRef)" "XY7Q2M"
    equals "...and the carrier"                     "$(ticket_field "$TDSET" "$TDMID" carrier)" "SBB"
    equals "...and the name printed on it"          "$(ticket_field "$TDSET" "$TDMID" travellerName)" "Ana Silva"
    TDREAD=$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")
    equals "...and it is STORED, not just echoed"   "$(ticket_field "$TDREAD" "$TDMID" seat)" "41A"

    # ACCEPTANCE 3: `validFrom`/`validUntil` ARE INSTANTS AND STAY INSTANTS.
    # A ticket valid "until 23:59" means 23:59 where the barrier is, and the way
    # that goes wrong is a well-meaning refactor rebasing the stored value onto
    # the event's zone. Against the LITERAL it was written as, because a rebase
    # that is symmetric — shift on set, shift back on clear — has already undone
    # itself by the time a baseline comparison samples it.
    equals "the validity comes back as written"     "$(ticket_field "$TDSET" "$TDMID" validUntil)" "2026-07-01T22:59:00.000Z"
    equals "...and so does the start of it"         "$(ticket_field "$TDSET" "$TDMID" validFrom)" "2026-07-01T07:00:00.000Z"
    body "${TDP[@]}" "${JSON[@]}" -X PATCH "$TDHOST" -d '{"timezone":"Europe/Lisbon"}' > /dev/null
    equals "setting the trip's zone moves neither"   \
      "$(ticket_field "$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")" "$TDMID" validUntil)" "2026-07-01T22:59:00.000Z"
    body "${TDP[@]}" "${JSON[@]}" -X PATCH "$TDHOST" -d '{"timezone":null}' > /dev/null
    equals "...and clearing it moves neither either" \
      "$(ticket_field "$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")" "$TDMID" validUntil)" "2026-07-01T22:59:00.000Z"
    body "${TDP[@]}" "${JSON[@]}" -X PATCH "$TDHOST" -d '{"timezone":"Europe/Lisbon"}' > /dev/null
    contains "the trip is in Lisbon for the reader"  "$(body "$BASE/api/invites/$TDTOK")" '"timezone":"Europe/Lisbon"'

    # ACCEPTANCE 4: THE ATTENDEE READS IT NEXT TO THE DOWNLOAD. The detail
    # travels WITH the ticket it belongs to and never one row further — which
    # since #37 means everyone on the event reads it, because everyone on the
    # event now reaches the ticket. A screen that offered the group's tickets
    # and withheld what is written on them would take the half of this issue
    # that matters at a barrier away from the person standing at it.
    TDEMAIL=$(body "${TDG[@]}" "$BASE/api/auth/get-session" | grep -o '"email":"[^"]*"' | head -1 | sed 's/^"email":"//;s/"$//')
    body "${JSON[@]}" -X POST "$BASE/api/invites/$TDTOK/rsvp" \
      -d "{\"status\":\"yes\",\"guestName\":\"CI Guest\",\"guestEmail\":\"$TDEMAIL\"}" > /dev/null
    TDRID=$(rsvp_id "$(body "${AUTH[@]}" "$API/events/$TDSLUG/rsvps")" "$TDEMAIL")
    check "a planner assigns the ticket to them"    200 "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/$TDMID/assignees" -d "{\"rsvpId\":\"$TDRID\"}"
    equals "...without losing what is written on it" \
      "$(ticket_field "$(body "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/$TDMID/assignees" -d "{\"rsvpId\":\"$TDRID\"}")" "$TDMID" seat)" "41A"
    TDGUEST=$(body "$BASE/api/invites/$TDTOK/media?email=$TDEMAIL")
    equals "the attendee's own ticket carries the seat" "$(ticket_field "$TDGUEST" "$TDMID" seat)" "41A"
    equals "...and the coach beside it"             "$(ticket_field "$TDGUEST" "$TDMID" coach)" "12"
    contains "...alongside a SIGNED download URL"   "$TDGUEST" 'X-Amz-Signature='
    # AND SO DOES ANYBODY ELSE ON THE LINK (#37). This used to assert the
    # opposite — `no-such-item`, and the seat absent from the body — and the
    # owner's decision reversed it: the person whose phone still has battery
    # reads the others' seats off it. What is NOT here is a claim that they own
    # the ticket; `mine` is asserted in the #37 block below.
    TDOTHER=$(body "$BASE/api/invites/$TDTOK/media?email=nobody@example.com")
    equals "a stranger on the same link reads the seat" "$(ticket_field "$TDOTHER" "$TDMID" seat)" "41A"
    contains "...and the seat number is in the body"  "$TDOTHER" '41A'
    contains "...and so is the booking reference"     "$TDOTHER" 'XY7Q2M'

    # ACCEPTANCE 2, THE EDIT HALF. A PUT REPLACES: what is not sent is cleared,
    # which is one meaning per request. The third line is the one that matters —
    # `null` rather than `no-detail` says the ROW survived the clearing, which
    # is what makes an empty detail a state rather than a deletion.
    TDED=$(body "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDMID/detail" -d '{"seat":"12C"}')
    equals "a planner corrects the seat"            "$(ticket_field "$TDED" "$TDMID" seat)" "12C"
    equals "...and what was not sent is cleared"    "$(ticket_field "$TDED" "$TDMID" bookingRef)" "null"
    equals "...the row itself surviving the clear"  "$(ticket_field "$TDED" "$TDMID" coach)" "null"
    excludes "...so the old seat is gone from the wire" \
      "$(body "$BASE/api/invites/$TDTOK/media?email=$TDEMAIL")" '41A'

    # A TICKET WITH NOTHING FILLED IN IS STILL A TICKET. `{}` is a legal body —
    # it must not arrive as a 400, and it must leave a row rather than removing
    # one. This is the rule the issue states in terms, executed.
    check "an empty detail is accepted"             200 "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDMID/detail" -d '{}'
    TDEMPTY=$(body "${TDP[@]}" "$TDHOST/media")
    equals "...leaving a row that says nothing"     "$(ticket_field "$TDEMPTY" "$TDMID" seat)" "null"
    equals "...and no stale validity on it"         "$(ticket_field "$TDEMPTY" "$TDMID" validUntil)" "null"
    equals "...while the ticket itself is untouched" "$(media_field "$TDEMPTY" "$TDMID" fileName)" "lisbon.pdf"
    excludes "...and the attendee reads no stale seat" \
      "$(body "$BASE/api/invites/$TDTOK/media?email=$TDEMAIL")" '12C'

    # A PHOTO HAS NO BOOKING REFERENCE, and the refusal is 422 rather than 400:
    # a 400 would mean zod refused the body and the domain rule was never
    # consulted, which is a different finding and the same colour.
    TDPPRE=$(body "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/presign" \
      -d '{"type":"photo","fileName":"platform.png","mimeType":"image/png","sizeBytes":8}')
    TDPID=$(json_field "$TDPPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: image/png' --data-binary 'eightbit' "$(json_field "$TDPPRE" upload.url)"
    body "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/confirm" -d "{\"mediaId\":\"$TDPID\"}" > /dev/null
    check "a photo has no seat to write"            422 "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDPID/detail" -d '{"seat":"41A"}'
    contains "...and says why, in words"            "$(body "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDPID/detail" -d '{"seat":"41A"}')" 'Only a ticket'
    equals "...and the photo still reports none"    "$(ticket_field "$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")" "$TDPID" seat)" "no-detail"

    # A REAL TICKET FROM ANOTHER TRIP, not a made-up id. The two are the same
    # 404 today and stop being the same the moment somebody drops the `eventId`
    # half of the lookup — at which point a made-up id still 404s and this check
    # still passes while a stranger's seat number can be overwritten. The owner
    # plans both trips, so the gate lets the request through and only the
    # scoping refuses it.
    TDSLUG2=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
      -d "{\"title\":\"Smoke ticket other $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
    TDOPRE=$(body "${TDP[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$TDSLUG2/media/presign" \
      -d "{\"type\":\"ticket\",\"fileName\":\"elsewhere.pdf\",\"mimeType\":\"application/pdf\",\"sizeBytes\":$TDSIZE}")
    TDOMID=$(json_field "$TDOPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: application/pdf' --data-binary "$TDPDF" "$(json_field "$TDOPRE" upload.url)"
    body "${TDP[@]}" "${JSON[@]}" -X POST "$BASE/api/host/events/$TDSLUG2/media/confirm" -d "{\"mediaId\":\"$TDOMID\"}" > /dev/null
    check "a real ticket from ANOTHER trip is 404"  404 "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDOMID/detail" -d '{"seat":"41A"}'
    check "...and the same in reverse"              404 "${TDP[@]}" "${JSON[@]}" -X PUT "$BASE/api/host/events/$TDSLUG2/media/$TDMID/detail" -d '{"seat":"41A"}'

    # A TICKET STILL UPLOADING MAY BE ANNOTATED — a planner typing the seat
    # while 4 MB of PDF goes up is doing the ordinary thing — and it stays
    # invisible until the upload is confirmed, which is what makes that harmless.
    TDQPRE=$(body "${TDP[@]}" "${JSON[@]}" -X POST "$TDHOST/media/presign" \
      -d "{\"type\":\"ticket\",\"fileName\":\"pending.pdf\",\"mimeType\":\"application/pdf\",\"sizeBytes\":$TDSIZE}")
    TDQID=$(json_field "$TDQPRE" mediaId)
    check "a ticket still uploading may be annotated" 200 "${TDP[@]}" "${JSON[@]}" -X PUT "$TDHOST/media/$TDQID/detail" -d '{"seat":"9F"}'
    equals "...and is still invisible until confirmed" \
      "$(media_field "$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")" "$TDQID" id)" "no-such-item"

    # DELETING THE TICKET TAKES WHAT WAS WRITTEN ON IT. The cascade is a
    # Postgres constraint and nothing else: a composite foreign key that failed
    # to cascade would make this DELETE a 500, which is what the 200 rules out.
    check "a planner deletes the annotated ticket"  200 "${TDP[@]}" -X DELETE "$TDHOST/media/$TDMID"
    TDGONE=$(body "${AUTH[@]}" "$API/events/$TDSLUG/media")
    equals "...and the ticket is gone from the list" "$(media_field "$TDGONE" "$TDMID" id)" "no-such-item"
    equals "...while the photo beside it remains"    "$(media_field "$TDGONE" "$TDPID" id)" "$TDPID"
  else
    echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run the ticket rows"
  fi
else
  echo "  skip  set both ZAEME_TEST_SESSION_COOKIE and ZAEME_TEST_GUEST_COOKIE to run these"
fi

echo
echo "== one ticket cannot cover two people (Bermos/zaeme#36) =="
# `events_media.assigned_rsvp_id` was ONE nullable foreign key, so a ticket
# belonged to exactly one person or to nobody. A pair fare, a family entry, a
# group booking for six behind one QR code: each had to be given to one of them
# and explained in the chat, while everybody else on it saw no ticket at all.
# `events_ticket_assignment` is the many-to-many that replaces it, and the
# column is GONE.
#
# WHAT ONLY A DATABASE CAN SHOW, which is why this block is here and not in
# `pnpm test`: the join, the unique index that makes "add Ben" idempotent, the
# TWO composite foreign keys that stop a ticket on one trip being given to an
# RSVP on another, and the cascade that un-assigns a ticket when its attendee
# leaves. `pnpm test` reads the schema file and executes no SQL at all.
#
# AND THE #78 TRAP, WHICH IS WHY IT WRITES ON ONE SURFACE AND READS ON ANOTHER.
# There are THREE media reads that share no code — the host card's, `/api/v1`'s
# (a different projection, a different order) and the invite link's — and
# `v1-shapes.ts` casts its row unchecked, so a read that never selected
# `assignedRsvpIds` answers `[]` with the typecheck green. That is exactly how
# `expenseId` (#29) and `ticket` (#35) each shipped wrong for a release. So
# every assignment below is MADE on the host surface and READ back on at least
# one other, and `ticket_assignees` answers `no-field` rather than `none` when
# a surface has stopped carrying the field at all.
#
# IT LEAVES ITS TICKET ASSIGNED, deliberately, where the #35 block deletes its
# own. `scripts/ci-upgrade-check.mjs` compares what the previous release said
# about a ticket against what this release says after the migration, and a
# suite that tidied every assignment away would leave that comparison with
# nothing but empty lists to agree about.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  TAP=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")

  # Its own trip, published so an invite token resolves on it: this script
  # re-runs against the previous run's rows.
  TASLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke pair fare $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG/status" -d '{"status":"published"}' > /dev/null
  TATOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG/invites" -d '{"label":"Pair fare smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  TAHOST="$BASE/api/host/events/$TASLUG"
  echo "  trip: $TASLUG"

  # --- WHO MAY SAY WHO A TICKET IS FOR. Needs no object storage: every
  #     credential gate runs before the media row is looked up. The add and the
  #     remove are separate routes now, so both are asked — a gate on one of a
  #     pair of verbs is the half of a boundary that gets forgotten.
  check "an anonymous assignment is refused"       401 "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":"nope"}'
  check "...and an anonymous removal too"          401 "${JSON[@]}" -X DELETE "$TAHOST/media/nope/assignees/nope"
  check "a service token is not a planner here"    401 "${AUTH[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":"nope"}'
  check "the invite link never gained the route"   404 "${JSON[@]}" -X POST "$BASE/api/invites/$TATOK/media/nope/assignees" -d '{"rsvpId":"nope"}'
  check "...nor did the machine API"               404 "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG/media/nope/assignees" -d '{"rsvpId":"nope"}'
  check "...nor the account surface"               404 "${TAP[@]}" "${JSON[@]}" -X POST "$BASE/api/me/events/$TASLUG/media/nope/assignees" -d '{"rsvpId":"nope"}'
  # THE ROUTE THAT USED TO DO THIS IS GONE, and 404 is what says so. A `set`
  # verb surviving beside `add`/`remove` would be a third way to change the
  # same rows — and the one that cannot express a pair fare.
  check "the old set-the-one-attendee route is gone" 404 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assign" -d '{"rsvpId":"nope"}'
  # A PLANNER naming a ticket that does not exist gets a 404 rather than a 403:
  # the line that says the refusals above are about the CREDENTIAL and not
  # about the made-up media id they all carry.
  check "a planner with no such ticket gets a 404" 404 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":"nope"}'
  check "...and the same on the removal"           404 "${TAP[@]}" "${JSON[@]}" -X DELETE "$TAHOST/media/nope/assignees/nope"
  # AND THE BODY IS STILL REQUIRED TO NAME SOMEBODY. `{"rsvpId":null}` used to
  # be how the old route meant "unassign"; there is no such request now, and a
  # 400 rather than a 200-that-did-nothing is what says the meaning went away
  # with the route.
  check "assigning to nobody is not a request"     400 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":null}'

  # ASK WHAT THE GUARD PERMITS, NOT WHAT IT FORBIDS (#74). `logistics` is a real
  # planner row and is the one role `assertPlanner(roles: [owner, co_planner])`
  # exists to keep out, so the 403 it earns is a different question from the
  # credential refusals above. Needs the second account.
  if [ -n "${ZAEME_TEST_GUEST_COOKIE:-}" ]; then
    TAG=(-H "Cookie: $ZAEME_TEST_GUEST_COOKIE")
    check "an account with no standing on the trip" 403 "${TAG[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":"nope"}'
    TALOG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG/planner-invites" -d '{"role":"logistics"}' \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    contains "a second account really is a logistics planner" \
      "$(body "${TAG[@]}" "${JSON[@]}" -X POST "$BASE/api/host/join/$TALOG/accept")" '"role":"logistics"'
    check "...and a logistics planner may not assign" 403 "${TAG[@]}" "${JSON[@]}" -X POST "$TAHOST/media/nope/assignees" -d '{"rsvpId":"nope"}'
    check "...nor un-assign"                          403 "${TAG[@]}" "${JSON[@]}" -X DELETE "$TAHOST/media/nope/assignees/nope"
  else
    echo "  skip  set ZAEME_TEST_GUEST_COOKIE to run the logistics-planner half"
  fi

  # --- THE ROWS THEMSELVES. These need a bucket, because there is no ticket
  #     without an upload, and skip as ONE line without one — exactly like the
  #     #35 block above. CI always has `adobe/s3mock` and fails on any `skip`.
  if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
    TAPDF='%PDF-1.4 one QR code, three people through the barrier.'
    TASIZE=${#TAPDF}
    TAPRE=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/presign" \
      -d "{\"type\":\"ticket\",\"fileName\":\"family.pdf\",\"mimeType\":\"application/pdf\",\"sizeBytes\":$TASIZE}")
    TAMID=$(json_field "$TAPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: application/pdf' --data-binary "$TAPDF" "$(json_field "$TAPRE" upload.url)"
    check "a planner uploads a family ticket"      200 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/confirm" -d "{\"mediaId\":\"$TAMID\"}"

    # FOUR people on the trip and only three on the ticket. The fourth is the
    # fixture the wrong answer needs: a rule that marked every ticket as
    # everybody's would pass every line below without them.
    for who in ana ben cy dee; do
      body "${JSON[@]}" -X POST "$BASE/api/invites/$TATOK/rsvp" \
        -d "{\"status\":\"yes\",\"guestName\":\"${who}\",\"guestEmail\":\"$who-$SUFFIX@example.com\"}" > /dev/null
    done
    TARSVPS=$(body "${AUTH[@]}" "$API/events/$TASLUG/rsvps")
    TAANA=$(rsvp_id "$TARSVPS" "ana-$SUFFIX@example.com")
    TABEN=$(rsvp_id "$TARSVPS" "ben-$SUFFIX@example.com")
    TACY=$(rsvp_id "$TARSVPS" "cy-$SUFFIX@example.com")
    TADEE=$(rsvp_id "$TARSVPS" "dee-$SUFFIX@example.com")
    equals "four people RSVP'd, and they are four"  \
      "$(printf '%s\n' "$TAANA" "$TABEN" "$TACY" "$TADEE" | grep -c '^no-such-rsvp$')" "0"

    # A FRESH TICKET IS NOBODY'S, and `none` rather than `no-field` is the line
    # that says the field is being carried at all — see the helper's header.
    TAV1=$(body "${AUTH[@]}" "$API/events/$TASLUG/media")
    equals "a fresh ticket is for nobody"          "$(ticket_assignees "$TAV1" "$TAMID")" "none"
    equals "...on the host surface too"            "$(ticket_assignees "$(body "${TAP[@]}" "$TAHOST/media")" "$TAMID")" "none"
    contains "...as an empty list, not a gap"      "$TAV1" '"assignedRsvpIds":[]'
    # AND THE COLUMN IT REPLACED IS GONE FROM THE WIRE. A scalar left beside the
    # list is two answers to one question, and the one the old clients read.
    excludes "...and no single assignee beside it" "$TAV1" 'assignedRsvpId"'

    # ACCEPTANCE 1: A TICKET ASSIGNED TO THREE PEOPLE IS MARKED AS THEIRS FOR
    # ALL THREE. Written on the HOST surface, one call per person, and read back
    # on the MACHINE one — which is the pair of surfaces the #78 trap lives
    # between.
    TAADD=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TAANA\"}")
    equals "the first attendee is on the ticket"   "$(ticket_assignees "$TAADD" "$TAMID")" "$TAANA"
    body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TABEN\"}" > /dev/null
    TAADD3=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TACY\"}")
    TATHREE=$(sorted_ids "$TAANA" "$TABEN" "$TACY")
    equals "...and so are the second and the third" "$(ticket_assignees "$TAADD3" "$TAMID")" "$TATHREE"
    equals "...STORED, not just echoed back"       "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$TATHREE"
    equals "...and the host card agrees"           "$(ticket_assignees "$(body "${TAP[@]}" "$TAHOST/media")" "$TAMID")" "$TATHREE"

    # THE SAME TICKET IS ON ALL THREE SCREENS. The guest read is the surface the
    # issue is actually about: one file, three people, each of whom sees it as
    # theirs. Read through the invite link, which is a third credential and a
    # third projection. (Since #37 a fourth person sees the file too — what
    # these three lines assert is that it names the right three.)
    TAGANA=$(body "$BASE/api/invites/$TATOK/media?email=ana-$SUFFIX@example.com")
    TAGBEN=$(body "$BASE/api/invites/$TATOK/media?email=ben-$SUFFIX@example.com")
    TAGCY=$(body "$BASE/api/invites/$TATOK/media?email=cy-$SUFFIX@example.com")
    equals "the first attendee sees it as theirs"  "$(ticket_assignees "$TAGANA" "$TAMID")" "$TATHREE"
    equals "...and so does the second"             "$(ticket_assignees "$TAGBEN" "$TAMID")" "$TATHREE"
    equals "...and so does the third"              "$(ticket_assignees "$TAGCY" "$TAMID")" "$TATHREE"
    contains "...each of them getting the file"    "$TAGANA" 'family.pdf'
    contains "...alongside a SIGNED download URL"  "$TAGANA" 'X-Amz-Signature='
    # AND THE FOURTH ATTENDEE SEES IT AND IS NOT ON IT — which since #37 is a
    # different sentence from "sees nothing". The invite link reaches every
    # ticket on the event now (the owner's decision, D2 revised), so what these
    # two lines prove is the ASSIGNMENT SET rather than the visibility: the
    # ticket names the three people it is for on the screen of somebody who is
    # not one of them. `mine` is asserted in the #37 block below, where the
    # fixture is built for it.
    TAGDEE=$(body "$BASE/api/invites/$TATOK/media?email=dee-$SUFFIX@example.com")
    equals "the fourth attendee sees whose it is"  "$(ticket_assignees "$TAGDEE" "$TAMID")" "$TATHREE"
    contains "...and gets the file itself"         "$TAGDEE" 'family.pdf'
    equals "a stranger on the link reads the same" \
      "$(ticket_assignees "$(body "$BASE/api/invites/$TATOK/media?email=nobody@example.com")" "$TAMID")" "$TATHREE"

    # ADDING SOMEBODY ALREADY ON IT IS THE SAME STATE, not a 409 and not a
    # fourth row. This is the `(media_id, rsvp_id)` unique index doing the work,
    # and the count is what proves it — a duplicate row would read as four ids.
    check "adding the same person again is a 200"  200 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TABEN\"}"
    equals "...and leaves three people, not four"  "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$TATHREE"

    # ACCEPTANCE 2: REMOVING ONE ASSIGNEE LEAVES THE OTHERS. The whole of what
    # the old column could not do: its only "remove" meant nobody has it now.
    TAREM=$(body "${TAP[@]}" "${JSON[@]}" -X DELETE "$TAHOST/media/$TAMID/assignees/$TABEN")
    TATWO=$(sorted_ids "$TAANA" "$TACY")
    equals "removing one leaves the other two"     "$(ticket_assignees "$TAREM" "$TAMID")" "$TATWO"
    equals "...on the machine surface as well"     "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$TATWO"
    # The one removed still HOLDS the link and still sees the file (#37); what
    # he has lost is his place on it, which is what this reads.
    equals "...and the one removed is off the list" \
      "$(ticket_assignees "$(body "$BASE/api/invites/$TATOK/media?email=ben-$SUFFIX@example.com")" "$TAMID")" "$TATWO"
    equals "...while the first still has it, now for two" \
      "$(ticket_assignees "$(body "$BASE/api/invites/$TATOK/media?email=ana-$SUFFIX@example.com")" "$TAMID")" "$TATWO"
    # Idempotent in the same direction: removing somebody who is not on it is
    # the state the caller asked for, so it is a 200 and changes nothing.
    check "removing a non-assignee is a 200"       200 "${TAP[@]}" "${JSON[@]}" -X DELETE "$TAHOST/media/$TAMID/assignees/$TABEN"
    equals "...and still leaves the other two"     "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$TATWO"

    # WHAT IS WRITTEN ON IT SURVIVES A CHANGE OF ASSIGNEE, and vice versa. The
    # two tables are independent and the answers carry each other, so neither
    # write may read as the other having been undone (#35).
    body "${TAP[@]}" "${JSON[@]}" -X PUT "$TAHOST/media/$TAMID/detail" -d '{"seat":"41A","coach":"12"}' > /dev/null
    TAWITH=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TABEN\"}")
    equals "an assignment keeps what is on the ticket" "$(ticket_field "$TAWITH" "$TAMID" seat)" "41A"
    TADET=$(body "${TAP[@]}" "${JSON[@]}" -X PUT "$TAHOST/media/$TAMID/detail" -d '{"seat":"9F"}')
    equals "...and writing the seat keeps the people" "$(ticket_assignees "$TADET" "$TAMID")" "$TATHREE"
    equals "...the attendee reading the new seat"  \
      "$(ticket_field "$(body "$BASE/api/invites/$TATOK/media?email=cy-$SUFFIX@example.com")" "$TAMID" seat)" "9F"

    # A PHOTO IS NOBODY'S IN PARTICULAR, and 422 rather than 400: a 400 would
    # mean zod refused the body and the domain rule was never consulted.
    TAPPRE=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/presign" \
      -d '{"type":"photo","fileName":"platform.png","mimeType":"image/png","sizeBytes":8}')
    TAPID=$(json_field "$TAPPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: image/png' --data-binary 'eightbit' "$(json_field "$TAPPRE" upload.url)"
    body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/confirm" -d "{\"mediaId\":\"$TAPID\"}" > /dev/null
    check "a photo is assigned to nobody"          422 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAPID/assignees" -d "{\"rsvpId\":\"$TAANA\"}"
    contains "...and says why, in words"           "$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAPID/assignees" -d "{\"rsvpId\":\"$TAANA\"}")" 'Only a ticket'
    equals "...and the photo still reports nobody" "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAPID")" "none"

    # AN RSVP FROM ANOTHER TRIP IS A 404, and it is a REAL one rather than a
    # made-up id: the two are the same answer today and stop being the same the
    # moment somebody drops the `eventId` half of the lookup, at which point a
    # made-up id still 404s and a stranger's ticket can be handed to somebody on
    # a different holiday. The composite foreign key refuses it underneath.
    TASLUG2=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
      -d "{\"title\":\"Smoke pair fare other $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
    body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG2/status" -d '{"status":"published"}' > /dev/null
    TATOK2=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TASLUG2/invites" -d '{"label":"Other trip"}' \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    body "${JSON[@]}" -X POST "$BASE/api/invites/$TATOK2/rsvp" \
      -d "{\"status\":\"yes\",\"guestName\":\"Elsewhere\",\"guestEmail\":\"elsewhere-$SUFFIX@example.com\"}" > /dev/null
    TAELSE=$(rsvp_id "$(body "${AUTH[@]}" "$API/events/$TASLUG2/rsvps")" "elsewhere-$SUFFIX@example.com")
    equals "the other trip really has an attendee" "$([ "$TAELSE" = "no-such-rsvp" ] && echo missing || echo found)" "found"
    check "an RSVP from ANOTHER trip is a 404"     404 "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAMID/assignees" -d "{\"rsvpId\":\"$TAELSE\"}"
    equals "...and the ticket is unchanged"        "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$TATHREE"

    # THE ATTENDEE LEAVING TAKES THEIR ASSIGNMENT AND NOT THE TICKET. This is
    # the `on delete cascade` on `(event_id, rsvp_id)` — the behaviour the old
    # column's `on delete set null` had, now per-person. Postgres does it or
    # nothing does; a missing cascade would make the DELETE a 500 instead.
    check "a planner removes the third attendee"   200 "${AUTH[@]}" -X DELETE "$API/events/$TASLUG/rsvps/$TACY"
    equals "...and the ticket is down to two"      "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID")" "$(sorted_ids "$TAANA" "$TABEN")"
    equals "...the file itself still there"        "$(media_field "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAMID" fileName)" "family.pdf"

    # DELETING THE TICKET TAKES ITS ASSIGNMENTS WITH IT — the other cascade,
    # `(event_id, media_id)`. Asserted on the SECOND ticket, so the first one
    # survives this run assigned, which is what the upgrade check needs.
    TAQPRE=$(body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/presign" \
      -d "{\"type\":\"ticket\",\"fileName\":\"spare.pdf\",\"mimeType\":\"application/pdf\",\"sizeBytes\":$TASIZE}")
    TAQID=$(json_field "$TAQPRE" mediaId)
    curl -s -o /dev/null -X PUT -H 'content-type: application/pdf' --data-binary "$TAPDF" "$(json_field "$TAQPRE" upload.url)"
    body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/confirm" -d "{\"mediaId\":\"$TAQID\"}" > /dev/null
    body "${TAP[@]}" "${JSON[@]}" -X POST "$TAHOST/media/$TAQID/assignees" -d "{\"rsvpId\":\"$TAANA\"}" > /dev/null
    equals "a second ticket is assigned too"       "$(ticket_assignees "$(body "${AUTH[@]}" "$API/events/$TASLUG/media")" "$TAQID")" "$TAANA"
    check "a planner deletes the second ticket"    200 "${TAP[@]}" -X DELETE "$TAHOST/media/$TAQID"
    TAGONE=$(body "${AUTH[@]}" "$API/events/$TASLUG/media")
    equals "...and it is gone from the list"       "$(ticket_assignees "$TAGONE" "$TAQID")" "no-such-item"
    equals "...while the family ticket remains"    "$(ticket_assignees "$TAGONE" "$TAMID")" "$(sorted_ids "$TAANA" "$TABEN")"
    # LEFT ASSIGNED ON PURPOSE. See this block's header: the next release's
    # `upgrade` job reads this row.
  else
    echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run the assignment rows"
  fi
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to run these"
fi

echo
echo "== everyone's tickets, one phone between four (Bermos/zaeme#37) =="
# `GET /api/invites/{token}/media?email=` used to FILTER the tickets by that
# address, so the friend whose battery survived a day out could open their own
# ticket and nobody else's while the group stood at the barrier holding a link
# with every file on it. The owner's decision (D2, revised 2026-09-14) is that
# this was never a permission boundary — "it's for friends, we do not need to
# segregate during an event between members" — so the invite link reaches EVERY
# ticket on the event and the email says which of them are yours.
#
# WHAT ONLY A RUNNING SERVER CAN SHOW, which is why these are here rather than
# in `pnpm test`: the RSVP-to-assignee join that decides `mine`, the second join
# that resolves each assignee's NAME (the guest page has names and no ids — an
# unresolved id renders as a cuid2), and the event scoping, which is the one
# thing a widening must not lose. `pnpm test` reads the source and runs no SQL.
#
# THE FIXTURE IS BUILT AROUND THE WRONG ANSWERS. Three people and two tickets:
# a pair fare for two of them, and a spare assigned to NOBODY. The third person
# is on the trip and on neither ticket, which is what stops "mark everything as
# everybody's" passing — the widening is about what you can SEE, and `mine` is
# still supposed to be true of exactly the right people. The spare is the
# acceptance criterion that a ticket nobody has been given is under All and not
# under Mine, and it is a real state: a planner uploads the group booking before
# working out who is on what.
#
# AND IT IS EXACTLY TICKETS. A document and a photo are uploaded to the same
# trip and asked for the `mine` field, which they must not have: `documents` and
# the gallery keep the rule they had, and loosening either of them "for
# symmetry" would be a decision nobody has made.
#
# The whole block is one fixture minted per run (`$SUFFIX`), because this script
# re-runs against the previous run's rows.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  TSP=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  TSSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke show-all $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSSLUG/status" -d '{"status":"published"}' > /dev/null
  TSTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSSLUG/invites" -d '{"label":"Show all smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  TSHOST="$BASE/api/host/events/$TSSLUG"
  TSMEDIA="$BASE/api/invites/$TSTOK/media"
  echo "  trip: $TSSLUG"

  # THE CREDENTIAL DID NOT MOVE, and this is the half that needs no bucket. What
  # a valid invite RETURNS changed; what counts as a valid invite did not, and
  # the route still reads the token and nothing else.
  check "the media read still needs a real token"  404 "$BASE/api/invites/not-a-token/media"
  check "...and an owner cookie is not a way in"   404 "${TSP[@]}" "$BASE/api/invites/not-a-token/media"
  check "...nor is the service token"              404 "${AUTH[@]}" "$BASE/api/invites/not-a-token/media"
  check "a real invite needs no identity at all"   200 "$TSMEDIA"
  # A MALFORMED IDENTITY IS STILL REFUSED. `email` stayed a validated optional
  # parameter when it stopped being a filter — a 400 here says the schema is
  # still reading it, which is what keeps `mine` from being decided by a string
  # nobody parsed.
  check "...but a malformed one is still a 400"    400 "$TSMEDIA?email=not-an-address"

  if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
    TSPDF='%PDF-1.4 two seats, one barcode, four phones and one battery.'

    # `upload_media <type> <fileName> <mimeType> <body> [hostBase]` — presign,
    # PUT, confirm, printing the media id. Five uploads in this block and the
    # dance is the same every time; a copy per upload is five places for a typo
    # to read as a feature being broken. `hostBase` defaults to this block's
    # trip and is passed only by the concert below, which is a different event.
    upload_media() {
      local pre mid host=${5:-$TSHOST}
      pre=$(body "${TSP[@]}" "${JSON[@]}" -X POST "$host/media/presign" \
        -d "{\"type\":\"$1\",\"fileName\":\"$2\",\"mimeType\":\"$3\",\"sizeBytes\":${#4}}")
      mid=$(json_field "$pre" mediaId)
      curl -s -o /dev/null -X PUT -H "content-type: $3" --data-binary "$4" "$(json_field "$pre" upload.url)"
      body "${TSP[@]}" "${JSON[@]}" -X POST "$host/media/confirm" -d "{\"mediaId\":\"$mid\"}" > /dev/null
      printf '%s' "$mid"
    }

    TSPAIR=$(upload_media ticket pair.pdf application/pdf "$TSPDF")
    TSSPARE=$(upload_media ticket spare.pdf application/pdf "$TSPDF")
    TSDOC=$(upload_media document plan.pdf application/pdf "$TSPDF")
    TSPHOTO=$(upload_media photo platform.png image/png 'eightbit')
    equals "four uploads, four distinct media rows"  \
      "$(printf '%s\n' "$TSPAIR" "$TSSPARE" "$TSDOC" "$TSPHOTO" | sort -u | wc -l | tr -d ' ')" "4"

    for who in Ana Ben Cleo; do
      body "${JSON[@]}" -X POST "$BASE/api/invites/$TSTOK/rsvp" \
        -d "{\"status\":\"yes\",\"guestName\":\"$who\",\"guestEmail\":\"$(printf '%s' "$who" | tr 'A-Z' 'a-z')-show-$SUFFIX@example.com\"}" > /dev/null
    done
    TSRSVPS=$(body "${AUTH[@]}" "$API/events/$TSSLUG/rsvps")
    TSANA=$(rsvp_id "$TSRSVPS" "ana-show-$SUFFIX@example.com")
    TSBEN=$(rsvp_id "$TSRSVPS" "ben-show-$SUFFIX@example.com")
    TSCLEO=$(rsvp_id "$TSRSVPS" "cleo-show-$SUFFIX@example.com")
    equals "three people RSVP'd, and they are three" \
      "$(printf '%s\n' "$TSANA" "$TSBEN" "$TSCLEO" | grep -c '^no-such-rsvp$')" "0"

    # The pair fare is Ana's and Ben's. The spare is nobody's, and stays nobody's.
    body "${TSP[@]}" "${JSON[@]}" -X POST "$TSHOST/media/$TSPAIR/assignees" -d "{\"rsvpId\":\"$TSANA\"}" > /dev/null
    body "${TSP[@]}" "${JSON[@]}" -X POST "$TSHOST/media/$TSPAIR/assignees" -d "{\"rsvpId\":\"$TSBEN\"}" > /dev/null
    body "${TSP[@]}" "${JSON[@]}" -X PUT "$TSHOST/media/$TSPAIR/detail" -d '{"seat":"41A","coach":"12"}' > /dev/null

    TSBOTH=$(sorted_ids "$TSPAIR" "$TSSPARE")
    TSANARES=$(body "$TSMEDIA?email=ana-show-$SUFFIX@example.com")
    TSCLEORES=$(body "$TSMEDIA?email=cleo-show-$SUFFIX@example.com")
    TSNONE=$(body "$TSMEDIA")
    TSSTRANGER=$(body "$TSMEDIA?email=nobody-show-$SUFFIX@example.com")

    # --- ACCEPTANCE: ALL SHOWS EVERY TICKET ON THE EVENT. Asserted as the SET,
    #     because a `contains` on one filename cannot tell a list of two from a
    #     list of one that happens to include it — and "one of the two" is
    #     exactly what the old behaviour returned.
    equals "the person on the ticket gets both"      "$(guest_bucket "$TSANARES" tickets)" "$TSBOTH"
    equals "the person on NEITHER gets both"         "$(guest_bucket "$TSCLEORES" tickets)" "$TSBOTH"
    equals "...and so does a viewer with no email"   "$(guest_bucket "$TSNONE" tickets)" "$TSBOTH"
    equals "...and an address nobody RSVP'd with"    "$(guest_bucket "$TSSTRANGER" tickets)" "$TSBOTH"
    contains "each of them signed, not just listed"  "$TSCLEORES" 'X-Amz-Signature='
    contains "...and named"                          "$TSCLEORES" 'pair.pdf'

    # --- ACCEPTANCE: MINE IS THE MARKER, AND IT IS STILL RIGHT. The widening is
    #     about what you can SEE; `mine` still has to be true of exactly the two
    #     people the ticket is for. `true`/`false` rather than present/absent —
    #     and `no-field` is a fifth answer the helper keeps apart, because a
    #     surface that stopped computing `mine` at all would otherwise read as
    #     "not yours" on every screen.
    equals "the pair fare is the first one's"        "$(guest_field "$TSANARES" tickets "$TSPAIR" mine)" "true"
    equals "...and the second one's"                 \
      "$(guest_field "$(body "$TSMEDIA?email=ben-show-$SUFFIX@example.com")" tickets "$TSPAIR" mine)" "true"
    equals "...and NOT the third one's"              "$(guest_field "$TSCLEORES" tickets "$TSPAIR" mine)" "false"
    equals "...nor a stranger's"                     "$(guest_field "$TSSTRANGER" tickets "$TSPAIR" mine)" "false"
    equals "...nor anybody's with no email given"    "$(guest_field "$TSNONE" tickets "$TSPAIR" mine)" "false"
    # THE ADDRESS IS MATCHED CASE-INSENSITIVELY, as every other email match in
    # this app is: a person who typed their address with a capital is the same
    # person, and telling them none of these is theirs is the empty-Mine screen
    # for somebody who did everything right.
    equals "...and a capitalised address is the same person" \
      "$(guest_field "$(body "$TSMEDIA?email=ANA-SHOW-$SUFFIX@example.com")" tickets "$TSPAIR" mine)" "true"

    # --- ACCEPTANCE: A TICKET ASSIGNED TO NOBODY IS UNDER ALL AND NOT UNDER MINE.
    equals "the spare is on everybody's list"        "$(guest_field "$TSANARES" tickets "$TSSPARE" fileName)" "spare.pdf"
    equals "...and is nobody's, not even the first one's" "$(guest_field "$TSANARES" tickets "$TSSPARE" mine)" "false"
    equals "...carrying an empty assignee list"      "$(ticket_assignees "$TSANARES" "$TSSPARE")" "none"

    # --- ACCEPTANCE: EVERY TICKET IS LABELLED WITH WHO IT IS FOR. Read on the
    #     screen of the person it is NOT for, which is the one that needs it:
    #     under All a ticket without a name against it is a file you cannot hand
    #     to the right friend. The ids are asserted on the same row, so the
    #     names and the ids stay ONE answer rather than two.
    equals "the pair fare names both people"         "$(ticket_names "$TSCLEORES" "$TSPAIR")" "Ana,Ben"
    equals "...by the same ids it lists"             "$(ticket_assignees "$TSCLEORES" "$TSPAIR")" "$(sorted_ids "$TSANA" "$TSBEN")"
    equals "...and the spare names nobody"           "$(ticket_names "$TSCLEORES" "$TSSPARE")" "none"
    # AND WHAT IS WRITTEN ON IT TRAVELS WITH IT (#35). The detail used to be
    # looked up only for the viewer's own tickets, so widening the list without
    # widening this would put a download button with no seat number in front of
    # the person actually standing at the barrier.
    equals "the seat is readable by the third one"   "$(ticket_field "$TSCLEORES" "$TSPAIR" seat)" "41A"
    equals "...and by a viewer with no email"        "$(ticket_field "$TSNONE" "$TSPAIR" coach)" "12"

    # --- EXACTLY TICKETS. `documents` and the gallery were already everybody's
    #     and are unchanged; what these assert is that they did not quietly
    #     become ticket views on the way past.
    equals "a shared document is still everybody's"  "$(guest_field "$TSNONE" documents "$TSDOC" fileName)" "plan.pdf"
    equals "...and carries no mine flag"             "$(guest_field "$TSNONE" documents "$TSDOC" mine)" "no-field"
    equals "a gallery photo is still everybody's"    "$(guest_field "$TSNONE" gallery "$TSPHOTO" fileName)" "platform.png"
    equals "...and carries no mine flag either"      "$(guest_field "$TSNONE" gallery "$TSPHOTO" mine)" "no-field"
    equals "...and no assignee list"                 "$(ticket_names "$(body "$TSMEDIA")" "$TSPHOTO")" "no-such-item"

    # --- THE WIDENING IS PER EVENT, WHICH IS THE ONE THING IT MUST NOT LOSE. A
    #     link to a DIFFERENT trip reaches none of these — "every ticket" means
    #     every ticket on this event, not every ticket on the instance, and the
    #     difference is one dropped `where event_id`.
    TSOTHER=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
      -d "{\"title\":\"Smoke show-all elsewhere $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
    body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSOTHER/status" -d '{"status":"published"}' > /dev/null
    TSOTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSOTHER/invites" -d '{"label":"Elsewhere"}' \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    equals "another trip's link reaches none of them" \
      "$(guest_bucket "$(body "$BASE/api/invites/$TSOTOK/media?email=ana-show-$SUFFIX@example.com")" tickets)" "none"

    # --- ACCEPTANCE 5, AND IT IS NOT QUITE THE SENTENCE THE ISSUE WROTE.
    #     "A concert exposes no uploaded tickets, because it has none" is a
    #     claim about PRACTICE — a concert announces an external
    #     `event.ticketUrl` and nobody uploads PDFs to one — and the issue asked
    #     for it to be verified rather than assumed. It is NOT enforced
    #     anywhere: `media/presign` accepts `ticket` for every event type, no
    #     invite mint refuses a concert, and the block below uploads one to
    #     prove it rather than arguing about it.
    #
    #     WHAT DOES HOLD, for every event type and not only for concerts, is
    #     that NO PUBLIC SURFACE CARRIES MEDIA AT ALL — `PublicEventPage` has no
    #     gallery, no documents and no tickets on it, and there is no public
    #     media route. That is the property the criterion is actually
    #     protecting, it is stronger than the one it names, and it is what these
    #     lines pin: the widening cannot reach anybody who is not holding an
    #     invite capability URL, whatever type the event is.
    TSCON=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
      -d "{\"title\":\"Smoke show-all gig $SUFFIX\",\"type\":\"concert\",\"startsAt\":\"2038-05-05T19:00:00Z\"}" \
      | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
    body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSCON/status" -d '{"status":"published"}' > /dev/null
    TSCONTKT=$(upload_media ticket gig.pdf application/pdf "$TSPDF" "$BASE/api/host/events/$TSCON")
    # THE ANTI-VACUITY GUARD, and it is the whole weight of the three
    # `excludes` below: if the upload had failed, "the public page does not
    # carry gig.pdf" would be true of a concert that has no gig.pdf anywhere.
    equals "a concert really does take a ticket upload" \
      "$(media_field "$(body "${AUTH[@]}" "$API/events/$TSCON/media")" "$TSCONTKT" fileName)" "gig.pdf"
    TSCONPUB=$(body "$BASE/api/public/events/$TSCON")
    contains "the gig's public page is really there"  "$TSCONPUB" "Smoke show-all gig $SUFFIX"
    excludes "...and carries no uploaded ticket"      "$TSCONPUB" 'gig.pdf'
    excludes "...nor any media bucket to put one in"  "$TSCONPUB" '"gallery"'
    TSCONLIST=$(body "$BASE/api/public/events")
    contains "the gig is on the open listing"         "$TSCONLIST" "Smoke show-all gig $SUFFIX"
    excludes "...and its ticket file is not"          "$TSCONLIST" 'gig.pdf'
    # AND THE HALF THE ISSUE ASSUMED: an invite link to the gig reaches that
    # ticket exactly as a trip's does. Nothing makes a concert special, so if
    # one should refuse the upload that is a decision for the owner and this is
    # the line that goes red when they make it.
    TSCONTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$TSCON/invites" -d '{"label":"Gig"}' \
      | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    equals "...while an invite to the gig does reach it" \
      "$(guest_bucket "$(body "$BASE/api/invites/$TSCONTOK/media")" tickets)" "$TSCONTKT"

    # --- AND THE OTHER TWO SURFACES DID NOT LEARN THIS PROJECTION. `mine` and
    #     `assignedTo` are the invite link's; `/api/v1` is Enterprise's contract
    #     (`docs/zaeme-api.openapi.yaml`, where neither field is declared) and
    #     the host card answers the planner, for whom "is it mine" is not a
    #     question. A field leaking into either is a shape change nobody asked
    #     for — into `/api/v1`, one another repository generates tools from.
    TSV1=$(body "${AUTH[@]}" "$API/events/$TSSLUG/media")
    equals "the machine surface still lists the pair fare" "$(media_field "$TSV1" "$TSPAIR" fileName)" "pair.pdf"
    excludes "...and gained no mine flag"            "$TSV1" '"mine"'
    excludes "...nor an assignedTo list"             "$TSV1" 'assignedTo'
    TSHOSTMEDIA=$(body "${TSP[@]}" "$TSHOST/media")
    contains "the host card still lists it too"      "$TSHOSTMEDIA" 'pair.pdf'
    excludes "...and gained no mine flag"            "$TSHOSTMEDIA" '"mine"'
  else
    echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run the show-all rows"
  fi
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to run these"
fi

echo
echo "== a ticket on the step it belongs to (Bermos/zaeme#38) =="
# `events_media.timeline_item_id` has pinned a ticket to "the 09:14 to Porto"
# since the transplant. `/api/v1` has carried it that whole time; the two reads
# a PERSON looks at dropped it before it reached a screen, so no itinerary has
# ever said it back and nothing could SET it either — the three media writes
# that existed are the assignees, the ticket detail and the delete.
#
# WHAT ONLY A RUNNING SERVER CAN SHOW, which is why these are here rather than
# in `pnpm test`: that the column round-trips through a real UPDATE, that the
# pin is scoped to its own trip in both directions (the media row and the step),
# that a pin does not quietly clear the assignees or the seat written on the
# same row, and that all three surfaces now agree about where a file is.
# `pnpm test` reads the source and runs no SQL.
#
# THE FIXTURE IS BUILT AROUND THE WRONG ANSWERS. TWO steps and THREE files: a
# ticket, a shared paper and a photograph. The second step exists so "pinned to
# the 09:14" can be told from "pinned to everything" — a smear passes every
# `contains` on the first step and fails the set on the second — and so a MOVE
# can be asserted as the pin LEAVING one step while it arrives at the other,
# which no single check can see. The photograph is the type refusal, and it is
# on the same trip so the refusal cannot be confused with the trip being wrong.
#
# AND THE TICKET IS ASSIGNED AND HAS A SEAT before anything is pinned, because
# "the pin did not disturb the row it was written on" is the failure a
# `returning()` on the wrong columns produces, and it reads exactly like #36 or
# #35 having been undone.
#
# The whole block is one fixture minted per run (`$SUFFIX`), because this script
# re-runs against the previous run's rows.
if [ -n "${ZAEME_TEST_SESSION_COOKIE:-}" ]; then
  PINP=(-H "Cookie: $ZAEME_TEST_SESSION_COOKIE")
  PINSLUG=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events" \
    -d "{\"title\":\"Smoke pinned $SUFFIX\",\"type\":\"trip\"}" | sed -n 's/.*"slug":"\([^"]*\)".*/\1/p')
  body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PINSLUG/status" -d '{"status":"published"}' > /dev/null
  PINTOK=$(body "${AUTH[@]}" "${JSON[@]}" -X POST "$API/events/$PINSLUG/invites" -d '{"label":"Pinned smoke"}' \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  PINHOST="$BASE/api/host/events/$PINSLUG"
  PINMEDIA="$BASE/api/invites/$PINTOK/media"
  echo "  trip: $PINSLUG"

  PINSTEP1=$(json_field "$(body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/timeline" \
    -d '{"title":"09:14 to Porto","type":"transport"}')" item.id)
  PINSTEP2=$(json_field "$(body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/timeline" \
    -d '{"title":"Check in","type":"accommodation"}')" item.id)
  equals "two steps on the plan, and they are two" \
    "$(printf '%s\n' "$PINSTEP1" "$PINSTEP2" | grep -c '^..*$')" "2"

  # A STEP ON A DIFFERENT TRIP, for the scoping refusal below. `$SLUG` is the
  # machine surface's own event and already has an itinerary item on it.
  PINOTHER=$(body "${AUTH[@]}" "$API/events/$SLUG/timeline" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

  # THE CREDENTIAL, and this half needs no bucket. The verb is a planner's, on
  # the host surface, and none of the other two credentials is a way in — the
  # media id is made up on purpose: authentication happens before the lookup, so
  # a 401 here is about the credential and nothing else.
  PINNOWHERE="$PINHOST/media/no-such-media-at-all/timeline-item"
  check "pinning needs a session"                  401 "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{"timelineItemId":null}'
  check "...and a service token is not one"        401 "${AUTH[@]}" "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{"timelineItemId":null}'
  check "...nor is the invite token"               401 -H "Authorization: Bearer $PINTOK" "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{"timelineItemId":null}'
  check "the invite link has no such verb at all"  404 "${JSON[@]}" -X PUT "$BASE/api/invites/$PINTOK/media/whatever/timeline-item" -d '{"timelineItemId":null}'
  # AN ABSENT FIELD IS NOT AN UN-PIN. `timelineItemId` is required AND nullable,
  # so a client that forgets it fails loudly rather than silently un-pinning —
  # which is the one outcome a planner cannot tell from "it did not save".
  check "an absent timelineItemId is refused"      400 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{}'
  check "...and so is one that is not an id"       400 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{"timelineItemId":42}'
  check "an unknown media id"                      404 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINNOWHERE" -d '{"timelineItemId":null}'

  if [ -n "${S3_BUCKET:-}${R2_BUCKET:-}" ]; then
    PINPDF='%PDF-1.4 the 09:14 to Porto, coach 12, seat 41A.'
    pin_upload() {
      local pre mid
      pre=$(body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/media/presign" \
        -d "{\"type\":\"$1\",\"fileName\":\"$2\",\"mimeType\":\"$3\",\"sizeBytes\":${#4}}")
      mid=$(json_field "$pre" mediaId)
      curl -s -o /dev/null -X PUT -H "content-type: $3" --data-binary "$4" "$(json_field "$pre" upload.url)"
      body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/media/confirm" -d "{\"mediaId\":\"$mid\"}" > /dev/null
      printf '%s' "$mid"
    }

    PINTKT=$(pin_upload ticket porto.pdf application/pdf "$PINPDF")
    PINDOC=$(pin_upload document hotel.pdf application/pdf "$PINPDF")
    PINPHOTO=$(pin_upload photo platform.png image/png 'eightbit')
    equals "three uploads, three distinct media rows" \
      "$(printf '%s\n' "$PINTKT" "$PINDOC" "$PINPHOTO" | sort -u | wc -l | tr -d ' ')" "3"

    body "${JSON[@]}" -X POST "$BASE/api/invites/$PINTOK/rsvp" \
      -d "{\"status\":\"yes\",\"guestName\":\"Ana\",\"guestEmail\":\"ana-pin-$SUFFIX@example.com\"}" > /dev/null
    PINANA=$(rsvp_id "$(body "${AUTH[@]}" "$API/events/$PINSLUG/rsvps")" "ana-pin-$SUFFIX@example.com")
    body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/media/$PINTKT/assignees" -d "{\"rsvpId\":\"$PINANA\"}" > /dev/null
    body "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINTKT/detail" -d '{"seat":"41A","coach":"12"}' > /dev/null

    # --- THE FIELD IS THERE BEFORE ANYTHING IS PINNED, on every surface. This
    #     is the bug itself, asserted directly: `null` is "pinned to nothing"
    #     and `no-field` is "this read does not carry the pin", which is what
    #     both human reads answered for the whole life of the column.
    PIN0H=$(body "${PINP[@]}" "$PINHOST/media")
    PIN0G=$(body "$PINMEDIA")
    equals "the host read carries the pin, unpinned"   "$(pinned_step "$PIN0H" "$PINTKT")" "null"
    equals "...and so does the invite link's ticket"   "$(pinned_step "$PIN0G" "$PINTKT")" "null"
    equals "...and its shared paper"                   "$(pinned_step "$PIN0G" "$PINDOC")" "null"
    equals "...and the machine surface, as it always did" \
      "$(pinned_step "$(body "${AUTH[@]}" "$API/events/$PINSLUG/media")" "$PINTKT")" "null"

    # --- PINNING, AND THE ANSWER SAYS WHERE IT WENT.
    PINRES=$(body "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINTKT/timeline-item" \
      -d "{\"timelineItemId\":\"$PINSTEP1\"}")
    check "pinning the ticket to the 09:14"          200 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINTKT/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}"
    equals "the write answers with the step it set"   "$(pinned_step "$PINRES" "$PINTKT")" "$PINSTEP1"
    # A PIN IS NOT AN EDIT OF THE ROW IT IS WRITTEN ON. A `returning()` over the
    # wrong columns, or a view rebuilt without its loaders, reads here exactly
    # like #36 and #35 having been undone by somebody moving a ticket.
    equals "...with who it is for undisturbed"        "$(ticket_assignees "$PINRES" "$PINTKT")" "$PINANA"
    equals "...and what is written on it"             "$(ticket_field "$PINRES" "$PINTKT" seat)" "41A"

    PIN1H=$(body "${PINP[@]}" "$PINHOST/media")
    PIN1G=$(body "$PINMEDIA")
    equals "the host itinerary can see it there"      "$(pinned_step "$PIN1H" "$PINTKT")" "$PINSTEP1"
    equals "...and so can anybody holding the link"   "$(pinned_step "$PIN1G" "$PINTKT")" "$PINSTEP1"
    # THE SET, NOT A `contains`: "the ticket is on the 09:14" is also true of a
    # read that put every file on every step.
    equals "the 09:14 carries exactly that ticket"    "$(pinned_ids "$PIN1G" "$PINSTEP1")" "$PINTKT"
    equals "...and the other step carries nothing"    "$(pinned_ids "$PIN1G" "$PINSTEP2")" "none"
    # ACCEPTANCE: it appears on the step AND still in the Tickets section.
    equals "...while the Tickets section still has it" "$(guest_bucket "$PIN1G" tickets)" "$PINTKT"

    # --- A STEP CARRIES AS MANY AS THE PLANNER PUTS ON IT, unlike the receipt
    #     pin (#29), which is one per expense and clears the previous one.
    check "pinning the paper to the same step"       200 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINDOC/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}"
    PIN2G=$(body "$PINMEDIA")
    equals "the 09:14 now carries both"               "$(pinned_ids "$PIN2G" "$PINSTEP1")" "$(sorted_ids "$PINTKT" "$PINDOC")"
    equals "...and the paper is still a shared paper" "$(guest_bucket "$PIN2G" documents)" "$PINDOC"
    check "re-pinning where it already is"           200 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINDOC/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}"
    equals "...changes nothing"                       "$(pinned_ids "$(body "$PINMEDIA")" "$PINSTEP1")" "$(sorted_ids "$PINTKT" "$PINDOC")"

    # --- MOVING IS THE PIN LEAVING ONE STEP AS IT ARRIVES AT THE OTHER, which
    #     is two assertions: an implementation that only ever ADDED would pass
    #     the second and fail the first.
    check "moving the ticket to the next step"       200 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINTKT/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP2\"}"
    PIN3G=$(body "$PINMEDIA")
    equals "the 09:14 is left with just the paper"    "$(pinned_ids "$PIN3G" "$PINSTEP1")" "$PINDOC"
    equals "...and the ticket is on the other step"   "$(pinned_ids "$PIN3G" "$PINSTEP2")" "$PINTKT"

    # --- ACCEPTANCE: UN-PINNING LEAVES THE MEDIA ITEM INTACT. The pin comes
    #     off; the file, its assignees and its seat do not.
    check "un-pinning the ticket"                    200 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINTKT/timeline-item" -d '{"timelineItemId":null}'
    PIN4G=$(body "$PINMEDIA")
    equals "it is pinned to nothing again"            "$(pinned_step "$PIN4G" "$PINTKT")" "null"
    equals "...and that step is empty again"          "$(pinned_ids "$PIN4G" "$PINSTEP2")" "none"
    equals "...the file is still on the event"        "$(guest_bucket "$PIN4G" tickets)" "$PINTKT"
    equals "...still assigned to the same person"     "$(ticket_names "$PIN4G" "$PINTKT")" "Ana"
    equals "...and still saying which seat"           "$(ticket_field "$PIN4G" "$PINTKT" seat)" "41A"

    # --- WHAT MAY NOT GO ON A STEP, and what may not be named as one.
    PINBADTYPE=$(body "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINPHOTO/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}")
    check "a photograph does not go on a step"       422 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINPHOTO/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}"
    contains "...and the refusal says where it lives" "$PINBADTYPE" 'gallery'
    # A 422 AND NOT A 400: the schema let the request through and the domain
    # understood it and declined. The two are the same red in a `check … 4xx`
    # and opposite findings.
    equals "...and it really was not pinned"          "$(pinned_step "$(body "$PINMEDIA")" "$PINPHOTO")" "null"
    check "a step belonging to another trip"         404 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINDOC/timeline-item" -d "{\"timelineItemId\":\"$PINOTHER\"}"
    equals "...and the refusal moved nothing"         "$(pinned_ids "$(body "$PINMEDIA")" "$PINSTEP1")" "$PINDOC"
    check "a step id that is nobody's"               404 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINDOC/timeline-item" -d '{"timelineItemId":"no-such-step"}'
    # THE MEDIA ROW IS SCOPED TOO, and in the other direction: this planner owns
    # both trips, so a lookup that forgot `where event_id` would answer 200 and
    # pin a file onto an itinerary it is not on.
    check "a media id from another trip"             404 "${PINP[@]}" "${JSON[@]}" -X PUT "$BASE/api/host/events/$SLUG/media/$PINDOC/timeline-item" -d '{"timelineItemId":null}'
    # AN UPLOAD THAT NEVER LANDED cannot be pinned: a step pointing at bytes
    # that may never exist is a download button that 404s at a barrier.
    PINPEND=$(json_field "$(body "${PINP[@]}" "${JSON[@]}" -X POST "$PINHOST/media/presign" \
      -d '{"type":"ticket","fileName":"never.pdf","mimeType":"application/pdf","sizeBytes":12}')" mediaId)
    check "a pending upload cannot be pinned"        409 "${PINP[@]}" "${JSON[@]}" -X PUT "$PINHOST/media/$PINPEND/timeline-item" -d "{\"timelineItemId\":\"$PINSTEP1\"}"

    # --- AND THE THREE SURFACES AGREE. `/api/v1` carried this field before any
    #     of this and is unchanged; if the human reads and the machine one ever
    #     disagree about where a file is, one of them is lying to somebody.
    PINV1=$(body "${AUTH[@]}" "$API/events/$PINSLUG/media")
    equals "the machine surface agrees about the paper" "$(pinned_step "$PINV1" "$PINDOC")" "$PINSTEP1"
    equals "...and about the un-pinned ticket"          "$(pinned_step "$PINV1" "$PINTKT")" "null"
    equals "...and the host read agrees with both"      "$(pinned_step "$(body "${PINP[@]}" "$PINHOST/media")" "$PINDOC")" "$PINSTEP1"
  else
    echo "  skip  set S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET/S3_ENDPOINT to run the pinned rows"
  fi
else
  echo "  skip  set ZAEME_TEST_SESSION_COOKIE to run these"
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
