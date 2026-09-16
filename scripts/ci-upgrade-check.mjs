/**
 * Prove that a migration did its work on rows the PREVIOUS release wrote.
 *
 * This is the half of the `upgrade` job (`.github/workflows/ci.yml`) that a
 * smoke run cannot do for us. `scripts/api-smoke.sh` mints its own events with
 * the code under test, so on a migrated database every row it looks at was
 * written AFTER the migration — which is exactly the blind spot #63 is about.
 * What nothing else reads is the rows that were already there.
 *
 * Two subcommands, run either side of `node scripts/migrate.mjs`:
 *
 *   snapshot <file>   against the PREVIOUS release's server. Writes a canary
 *                     trip through `/api/v1` — a foreign-currency expense at a
 *                     pinned rate, a categorised one, several people — then
 *                     records every event that release can see and what its
 *                     budget says. The canary exists because "whatever the
 *                     smoke suite happened to leave" is a fixture nobody owns:
 *                     it changes shape whenever that file does, and a check
 *                     that silently stops finding money is the failure mode
 *                     this whole job exists to remove.
 *
 *   verify <file>     against the NEW release's server, after the migration.
 *                     Re-reads each of those events and asserts what a
 *                     migration is not allowed to change, then WRITES to the
 *                     canary — because a chart of accounts the migration
 *                     skipped is only felt by the next write.
 *
 * WHAT IS ASSERTED, and deliberately what is not. Every figure a migration may
 * legitimately restate is left alone — a check that has to be edited whenever
 * money legitimately moves is a check that gets weakened under deadline. So this
 * asserts the facts a person TYPED (the amount as spent, its currency, who paid)
 * and the ledger's own internal consistency AFTER the migration (every entry
 * sums to zero, every entry still lands in the category account it was filed
 * under, every line points at an account that exists).
 *
 * AND THE CURRENCY A TRIP IS DENOMINATED IN, which #59 added and which is the
 * one figure a migration may NOT restate even though it looks derived. That
 * release moved the currency off the instance and onto the event, filling
 * `events_event.currency` per trip; every balance on a trip is already frozen
 * against the currency its expenses carry, so a backfill that reached for a
 * constant, or for the instance setting rather than the trip's own rows, would
 * silently rename the units under a column of sums. Nothing else in this job
 * can see that: the ledger still balances, the totals still add up, and every
 * number is simply labelled something it is not. So both halves are pinned —
 * the budget's `currency` and each entry's `baseCurrency` — against what the
 * PREVIOUS release said they were.
 *
 * Proving the arithmetic of a particular backfill beyond that is that
 * migration's own job.
 *
 * THIS FILE SPEAKS TWO RELEASES' `/api/v1` AT ONCE, and that is a maintenance
 * obligation rather than an accident. `canaryExpenses` below has to be accepted
 * by the PREVIOUS release's `POST /api/v1/events/{slug}/expenses`, and `verify`
 * reads the shapes the NEW one answers with — `sameCategory` already carries
 * one such transition, the `other` -> `Uncategorised` rename #61 made.
 *
 * So a breaking change to that surface has a third file to move (after the
 * routes and `docs/zaeme-api.openapi.yaml`), and for the one release that
 * straddles the change this file has to accept both spellings. That is why
 * every request it makes either aborts with the response and a line saying
 * which side of the migration it was talking to, or asserts on a field it has
 * checked is there: whoever hits it will be mid-rename, and the job's job is to
 * say so rather than to fail as if the migration were wrong.
 *
 * Plain .mjs with no imports beyond node, like `scripts/migrate.mjs` and
 * `scripts/ci-smoke-setup.mjs`: it runs before and after a build, against two
 * different releases, and must not need either one's dependency tree.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:3111').replace(/\/$/, '')
const TOKEN = process.env.ZAEME_SERVICE_TOKEN
const OWNER = process.env.ZAEME_ENTERPRISE_OWNER_ID
if (!TOKEN || !OWNER) {
  console.error('[upgrade-check] ZAEME_SERVICE_TOKEN and ZAEME_ENTERPRISE_OWNER_ID are required')
  process.exit(1)
}

const API = `${BASE}/api/v1`
const HEADERS = {
  'authorization': `Bearer ${TOKEN}`,
  'x-mcp-user': OWNER,
  'content-type': 'application/json'
}

/**
 * The floor, in the spirit of `MIN_SMOKE_CHECKS`: what stops `verify` from
 * reporting success because it found nothing to look at.
 *
 * It is EXACTLY what the canary produces, counted from `verify` below rather
 * than estimated, because the canary is the one event `snapshot` guarantees:
 *
 *   1   the budget still loads
 *  16   two expenses x eight (survived, amount as spent, the currency it
 *       settles in, its rate is not claimed to have been checked, carries its
 *       lines, sums to zero, every line has an account, still filed under its
 *       category)
 *   1   the trip still settles in what it settled in
 *   2   everybody who had a balance still has one; the balances still close
 *   4   the write block: readable, recorded, filed under Food, total moved
 *  ---
 *  24
 *
 * `snapshot` refuses to write a file unless the canary came back with both of
 * those expenses AND a category on each, so every one of the 19 is reachable —
 * the producer's guarantee and this consumer's floor are the same statement,
 * which is the bug this number had when it was 24 against a canary worth 20.
 *
 * Whatever a run finds BEYOND the canary is the smoke suite's leftovers, and
 * this deliberately does not depend on how many of those there are: that file
 * is free to change what it leaves behind.
 */
const MIN_ASSERTIONS = 24

let pass = 0
let fail = 0

function ok(name) {
  pass++
  console.log(`  ok   ${name}`)
}

function bad(name, detail) {
  fail++
  console.log(`  FAIL ${name}`)
  if (detail !== undefined) console.log(`       ${detail}`)
}

function assert(name, condition, detail) {
  if (condition) ok(name)
  else bad(name, detail)
}

/** A hard stop: the check itself cannot run, which is never a pass. */
function abort(message) {
  console.error(`::error::[upgrade-check] ${message}`)
  process.exit(1)
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

/* --------------------------------- snapshot -------------------------------- */

/**
 * The canary's expenses, as the PREVIOUS release has to accept them.
 *
 * `category` is the lower-case enum value, which is what every release from the
 * baseline to today takes — #61 turned it into an account name and kept the old
 * spelling resolving, so one body works against both sides of that migration.
 * The rate is PINNED: a snapshot that needs frankfurter to answer would make
 * this job depend on somebody else's uptime.
 */
function canaryExpenses(stamp) {
  const people = [
    { name: 'Ada Canary', email: `ada+${stamp}@example.com` },
    { name: 'Bo Canary', email: `bo+${stamp}@example.com` },
    { name: 'Cy Canary', email: `cy+${stamp}@example.com` }
  ]
  return [
    {
      title: 'Canary chalet',
      category: 'accommodation',
      amountCents: 42000,
      paidByName: people[0].name,
      paidByEmail: people[0].email,
      participants: people
    },
    {
      // Foreign, at a rate that does not divide cleanly across three: the base
      // amounts are 3138/3137/3137, so a backfill that re-derives a share
      // rather than carrying it over cannot come out even by luck.
      title: 'Canary dinner',
      category: 'food',
      amountCents: 10000,
      currency: 'EUR',
      fxRate: '0.9412',
      paidByName: people[1].name,
      paidByEmail: people[1].email,
      participants: people
    }
  ]
}

async function snapshot(file) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
  const created = await api('POST', '/events', { title: `Upgrade canary ${stamp}`, type: 'trip' })
  if (created.status !== 201 || !created.json?.slug) {
    abort(
      `the previous release refused to create the canary trip (${created.status}): ${created.text.slice(0, 300)}\n`
      + 'If POST /api/v1/events has changed shape, this script speaks the OLD contract here and needs updating.'
    )
  }
  const canarySlug = created.json.slug

  for (const expense of canaryExpenses(stamp)) {
    const wrote = await api('POST', `/events/${canarySlug}/expenses`, expense)
    if (wrote.status !== 201) {
      abort(
        `the previous release refused canary expense "${expense.title}" (${wrote.status}): ${wrote.text.slice(0, 300)}\n`
        + 'If POST /api/v1/events/{slug}/expenses has changed shape, this script speaks the OLD contract here.'
      )
    }
  }

  const list = await api('GET', '/events')
  if (list.status !== 200 || !Array.isArray(list.json)) {
    abort(`GET /api/v1/events answered ${list.status} on the previous release: ${list.text.slice(0, 300)}`)
  }

  const events = []
  for (const summary of list.json) {
    const slug = summary?.slug
    if (!slug) continue
    const budget = await api('GET', `/events/${slug}/budget`)
    if (budget.status !== 200) continue
    const expenses = Array.isArray(budget.json?.expenses) ? budget.json.expenses : []
    if (!expenses.length) continue
    events.push({
      slug,
      currency: budget.json.currency ?? null,
      totalCents: budget.json.totalCents ?? null,
      expenses: expenses.map(e => ({
        id: e.id,
        title: e.title,
        category: e.category ?? null,
        amountCents: e.amountCents,
        currency: e.currency ?? null,
        amountBaseCents: e.amountBaseCents ?? null,
        // The currency this entry's money was converted INTO. #59 moved the
        // question from the instance to the trip; the answer for a row written
        // before that release must not move with it.
        baseCurrency: e.baseCurrency ?? null,
        paidByEmail: e.paidByEmail ?? null,
        shareCount: Array.isArray(e.shares) ? e.shares.length : null
      })),
      balances: (Array.isArray(budget.json?.balances) ? budget.json.balances : [])
        .map(b => ({ email: b.email, netCents: b.netCents }))
    })
  }

  // What `verify`'s floor rests on, asserted HERE, where the previous release
  // is still up and can say what went wrong. Both expenses, each with the
  // category it was filed under: those two facts are what make all 19 of that
  // floor's assertions reachable, so if this release reports its budget
  // differently the run stops at the producer rather than at the consumer with
  // a count nobody can explain.
  const canary = events.find(e => e.slug === canarySlug)
  if (!canary || canary.expenses.length !== 2) {
    abort(`the canary trip ${canarySlug} came back with ${canary?.expenses.length ?? 'no'} expenses, not 2`)
  }
  if (!canary.expenses.every(e => e.category)) {
    abort(
      `the canary trip ${canarySlug} came back with an expense carrying no category: `
      + `${JSON.stringify(canary.expenses.map(e => [e.title, e.category]))}. `
      + 'The previous release answers a shape this script does not read any more — update it.'
    )
  }

  const money = events.reduce((n, e) => n + e.expenses.length, 0)
  writeFileSync(file, JSON.stringify({ canarySlug, events }, null, 2))
  console.log(
    `[upgrade-check] snapshot: ${events.length} event(s) holding ${money} expense(s), canary ${canarySlug} -> ${file}`
  )
}

/* ---------------------------------- verify --------------------------------- */

/** `other` and the four old enum values name accounts now (#61). */
function sameCategory(before, after) {
  if (!before || !after) return false
  const b = before.trim().toLowerCase()
  const a = after.trim().toLowerCase()
  return a === b || (b === 'other' && a === 'uncategorised')
}

function sum(values) {
  return values.reduce((n, v) => n + v, 0)
}

async function verify(file) {
  let snap
  try {
    snap = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    abort(`no usable snapshot at ${file}: ${err.message}`)
  }
  if (!snap?.events?.length || !snap.canarySlug) {
    abort(`the snapshot at ${file} names no events — nothing would be asserted`)
  }

  for (const before of snap.events) {
    const res = await api('GET', `/events/${before.slug}/budget`)
    if (res.status !== 200) {
      bad(`${before.slug}: the budget still loads`, `answered ${res.status}: ${res.text.slice(0, 200)}`)
      continue
    }
    ok(`${before.slug}: the budget still loads`)
    const after = res.json
    const byId = new Map((after.expenses ?? []).map(e => [e.id, e]))

    for (const was of before.expenses) {
      const now = byId.get(was.id)
      if (!now) {
        bad(`${before.slug}/${was.title}: survived the migration`, `expense ${was.id} is gone`)
        continue
      }
      ok(`${before.slug}/${was.title}: survived the migration`)

      // What a person typed. No migration gets to restate this.
      assert(
        `${before.slug}/${was.title}: the amount as spent is untouched`,
        now.amountCents === was.amountCents && (was.currency === null || now.currency === was.currency),
        `was ${was.amountCents} ${was.currency}, now ${now.amountCents} ${now.currency}`
      )

      // #59's backfill, at the row level. `amountBaseCents` is allowed to move
      // (a recompute is what that release is for); the LABEL on it is not,
      // because the frozen figure beside it was converted at that currency's
      // rate and cannot be re-read as another.
      assert(
        `${before.slug}/${was.title}: the currency it settles in is untouched`,
        was.baseCurrency === null || now.baseCurrency === was.baseCurrency,
        `was converted into ${was.baseCurrency}, now says ${now.baseCurrency}`
      )

      // The other half of that backfill: a column that has to be filled for
      // every existing row and has no accurate value to fill it with. `fetched`
      // is the conservative one — "nobody told us this was checked against a
      // statement" — and a row that came back `manual` would be this migration
      // inventing a claim about verification that never happened.
      assert(
        `${before.slug}/${was.title}: its rate is not claimed to have been checked`,
        now.fxRateSource === undefined || now.fxRateSource === 'fetched',
        `fxRateSource came back as ${JSON.stringify(now.fxRateSource)}`
      )

      // The lines ARE the ledger since #61. If they ever stop being in the
      // response this check would quietly assert nothing, so it says so instead.
      if (!Array.isArray(now.lines)) {
        bad(
          `${before.slug}/${was.title}: the entry carries its lines`,
          'the budget response no longer has `lines` — this check reads it and needs updating, not deleting'
        )
        continue
      }
      ok(`${before.slug}/${was.title}: the entry carries its lines`)

      assert(
        `${before.slug}/${was.title}: the entry sums to zero`,
        sum(now.lines.map(l => l.amountCents)) === 0 && sum(now.lines.map(l => l.amountBaseCents)) === 0,
        `spent ${sum(now.lines.map(l => l.amountCents))}, base ${sum(now.lines.map(l => l.amountBaseCents))}`
      )

      assert(
        `${before.slug}/${was.title}: every line points at a real account`,
        now.lines.every(l => l.accountName && l.accountName !== 'Unknown account'),
        JSON.stringify(now.lines.filter(l => !l.accountName || l.accountName === 'Unknown account'))
      )

      // The chart of accounts the migration seeded for events that already
      // existed. Skip it if the previous release did not report a category at
      // all rather than inventing an expectation.
      if (was.category) {
        const debit = now.lines.find(l => l.accountKind === 'category' && l.amountCents > 0)
        assert(
          `${before.slug}/${was.title}: still filed under "${was.category}"`,
          Boolean(debit) && now.categoryAccountId && sameCategory(was.category, now.category),
          debit
            ? `was "${was.category}", now "${now.category}"`
            : 'the entry has no debit into any category account — the chart of accounts was not seeded for this event'
        )
      }
    }

    // There WAS an assertion here that `totalCents` equals the sum of the
    // debits into category accounts. It could not fail: `computeTotalCents`
    // (`server/domain/expenses.ts`) computes the total by summing exactly those
    // lines out of exactly this response, so the check restated the answer it
    // was checking and still counted towards the floor above. The honest
    // version of it is in the write block at the bottom of this function, where
    // the total has to move by an amount THIS script chose — which is what went
    // red when the chart of accounts was not seeded.
    // The trip's own currency. It is `null` in a snapshot taken before #59 only
    // if that release did not report one at all, which it did — the budget has
    // carried a `currency` since #25 — so this is a live check against every
    // release this job can straddle.
    assert(
      `${before.slug}: the trip still settles in what it settled in`,
      before.currency === null || after.currency === before.currency,
      `was ${before.currency}, now ${after.currency}`
    )

    const nowBalances = new Map((after.balances ?? []).map(b => [b.email, b.netCents]))
    const lost = before.balances.map(b => b.email).filter(email => !nowBalances.has(email))
    assert(
      `${before.slug}: everybody who had a balance still has one`,
      lost.length === 0,
      `missing: ${lost.join(', ')}`
    )
    assert(
      `${before.slug}: the balances still close`,
      sum([...nowBalances.values()]) === 0,
      `they sum to ${sum([...nowBalances.values()])}`
    )
  }

  /*
   * The write. Everything above reads; a chart of accounts the migration failed
   * to seed is only FELT when the next expense has to land in one — and it is
   * the failure that reaches a person as "I cannot record this", days after the
   * deploy went green. `Food` is the account name #61 seeded for the `food`
   * the canary was written with, so this asks the new release for an account
   * the migration was responsible for creating.
   */
  const canaryBefore = await api('GET', `/events/${snap.canarySlug}/budget`)
  if (canaryBefore.status !== 200) {
    bad('the canary trip is readable before the write', `answered ${canaryBefore.status}`)
  } else {
    ok('the canary trip is readable before the write')
    const totalBefore = canaryBefore.json.totalCents
    const people = (canaryBefore.json.balances ?? []).map(b => ({ name: b.name, email: b.email }))
    const wrote = await api('POST', `/events/${snap.canarySlug}/expenses`, {
      title: 'Post-migration nightcap',
      category: 'Food',
      amountCents: 3000,
      paidByName: people[0]?.name ?? 'Ada Canary',
      paidByEmail: people[0]?.email ?? 'ada@example.com',
      participants: people.length ? people : [{ name: 'Ada Canary', email: 'ada@example.com' }]
    })
    assert(
      'the new release records an expense into a category the migration seeded',
      wrote.status === 201,
      `answered ${wrote.status}: ${wrote.text.slice(0, 300)}`
    )
    assert(
      'and files it under Food',
      wrote.json?.category === 'Food',
      `category came back as ${JSON.stringify(wrote.json?.category)}`
    )

    const canaryAfter = await api('GET', `/events/${snap.canarySlug}/budget`)
    assert(
      'and the trip total moves by exactly that expense',
      canaryAfter.status === 200 && canaryAfter.json.totalCents === totalBefore + 3000,
      `total was ${totalBefore}, now ${canaryAfter.json?.totalCents}`
    )
  }

  console.log(`passed ${pass}, failed ${fail}`)
  if (fail > 0) {
    console.error(`::error::[upgrade-check] ${fail} assertion(s) failed against rows the previous release wrote`)
    process.exit(1)
  }
  if (pass < MIN_ASSERTIONS) {
    console.error(
      `::error::[upgrade-check] ${pass} assertions ran, fewer than the ${MIN_ASSERTIONS} the canary alone accounts `
      + 'for — a check above was removed or the budget response has changed shape, so this run did not look at what '
      + 'it says it looked at. Recount the arithmetic at MIN_ASSERTIONS in this file rather than lowering it.'
    )
    process.exit(1)
  }
}

const [command, file] = process.argv.slice(2)
if (command === 'snapshot' && file) await snapshot(file)
else if (command === 'verify' && file) await verify(file)
else {
  console.error('[upgrade-check] usage: node scripts/ci-upgrade-check.mjs <snapshot|verify> <file>')
  process.exit(1)
}
