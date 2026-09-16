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
 * AND WHAT A MIGRATION INVENTED, which is the other half of the same idea and
 * the one a purely additive release needs. #31 added `events_event.timezone`
 * with no backfill on purpose: an event that already exists has no display zone
 * and NULL is the truth about it, so a migration that reached for a constant —
 * the instance's own clock, the first place's country — would put a zone on
 * every trip nobody chose and quietly relabel every time on its itinerary. The
 * snapshot records what the previous release reported (nothing at all, before
 * that release; the stored value afterwards) and `verify` asserts against THAT
 * rather than against a constant, which is the mistake that broke every branch
 * until #72.
 *
 * AND THE CURRENCY A TRIP IS DENOMINATED IN, which #59 added and which is the
 * one figure a migration may NOT restate even though it looks derived. That
 * release moved the currency off the instance and onto the event, filling
 * `events_event.currency` per trip; every balance on a trip is already frozen
 * against the currency its expenses carry, so a backfill that reached for a
 * constant would silently rename the units under a column of sums. Nothing else
 * in this job can see that: the ledger still balances, the totals still add up,
 * and every number is simply labelled something it is not.
 *
 * WHAT THIS CANNOT TELL APART, said out loud so nobody reads more into a green
 * run than is there. #59's backfill takes an event's currency from its own
 * expenses' `base_currency`, falling back to the instance setting. Those two
 * sources DISAGREE only on a database where some trip's expenses were converted
 * into something the instance setting is not — and that state is unreachable
 * through the previous release's API, which writes `base_currency` from the
 * instance setting on every expense and answers 409 to any change that would
 * make them diverge. So a backfill that read the setting instead of the rows
 * passes this job on every database it can build. Only the constant is caught,
 * and only through the events that have NO expenses, which is why they are
 * snapshotted below rather than skipped.
 *
 * Proving the arithmetic of a particular backfill beyond that is that
 * migration's own job, on a database built by hand.
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
 *  14   two expenses x seven (survived, amount as spent, what it claims about
 *       verification, carries its lines, sums to zero, every line has an
 *       account, still filed under its category)
 *   1   the trip still settles in what it settled in
 *   1   the migration invented no display zone for it (#31)
 *   1   the migration wrote nothing on a ticket that was already there (#35) —
 *       vacuous on the canary, which has no media at all (it is written through
 *       `/api/v1`, which has no upload route), and counted anyway because the
 *       vacuum is the correct state and the assertion must not go missing
 *   2   everybody who had a balance still has one; the balances still close
 *   4   the write block: readable, recorded, filed under Food, total moved
 *  ---
 *  24
 *
 * `snapshot` refuses to write a file unless the canary came back with both of
 * those expenses AND a category on each, so every one of the 23 is reachable —
 * the producer's guarantee and this consumer's floor are the same statement,
 * which is the bug this number had when it was 24 against a canary worth 20.
 * (The prose said 19 in two places while the arithmetic above said 22, from the
 * recount that fixed that bug. Nothing reads a comment, so it stayed wrong. The
 * zone line above is the one #31 adds, counted the same way: one per event, and
 * the canary is the one event `snapshot` guarantees.)
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

/**
 * WHAT AN ENTRY CLAIMS ABOUT VERIFICATION: the label and the figure behind it.
 *
 * Read as ONE fact, because that is what it is (#59). `fx_rate_source` set to
 * `manual` means a PERSON stated what this cost — by typing the rate or by
 * typing what came out of their account — and `stated_amount_cents` /
 * `stated_currency` are that statement. The label without the figure is a claim
 * nobody can check; the figure without the label is a number with no
 * provenance. A migration may invent neither and destroy neither, so they are
 * snapshotted together and compared together.
 *
 * Every field is normalised to `null` when the release did not report it, so a
 * snapshot taken from a release that predates the columns compares cleanly
 * against one taken from a release that has them.
 */
function verificationClaim(row) {
  return {
    fxRateSource: row.fxRateSource ?? null,
    statedAmountCents: row.statedAmountCents ?? null,
    statedCurrency: row.statedCurrency ?? null
  }
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

/**
 * WHAT THIS RELEASE SAYS IS WRITTEN ON EACH OF AN EVENT'S MEDIA ROWS (#35),
 * recorded so `verify` can compare against it rather than against a constant.
 *
 * `events_ticket_detail` is a new TABLE with no backfill, which makes it the
 * same shape of claim as #31's display zone: an existing ticket genuinely has
 * nothing written on it, and a migration that invented a row — filling
 * `traveller_name` from the RSVP it is assigned to, say — would put words on
 * somebody's ticket that nobody typed. The honest fill is none.
 *
 * `'no-field'` means the previous release has no such field AT ALL, which is a
 * fact about that release and not a value in its database. `verify` reads that
 * case as "the only honest fill is null" and the other case as "leave it
 * exactly as it was", which is what keeps this live against a future base that
 * already has the column.
 */
async function mediaClaim(slug) {
  const res = await api('GET', `/events/${slug}/media`)
  if (res.status !== 200 || !Array.isArray(res.json)) return []
  return res.json
    .filter(m => m?.id)
    .map(m => ({
      id: m.id,
      type: m.type ?? null,
      ticket: Object.hasOwn(m, 'ticket') ? (m.ticket ?? null) : 'no-field'
    }))
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
    // WHAT THIS RELEASE SAYS THE EVENT'S DISPLAY ZONE IS (#31), off the summary
    // this loop already has. `undefined` here means the previous release has no
    // such field at all, which is a fact about that release and not a value in
    // its database; it is normalised to null and `verify` reads the two cases
    // apart the same way `verificationClaim` does.
    const timezone = summary.timezone ?? null
    // An event with NO expenses used to be skipped here, which left the half of
    // #59's backfill that fills from the instance setting checked by nothing —
    // and that is the only half this job can check at all. They are cheap (one
    // budget read each) and they carry the assertion that matters most: the
    // currency they came out with.
    const expenses = Array.isArray(budget.json?.expenses) ? budget.json.expenses : []
    events.push({
      slug,
      timezone,
      media: await mediaClaim(slug),
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
        shareCount: Array.isArray(e.shares) ? e.shares.length : null,
        // WHAT THIS ROW CLAIMS ABOUT VERIFICATION (#59), recorded so `verify`
        // can compare against it instead of against a constant — see the long
        // note there. `null` in any of the three means the previous release
        // reported no such field at all, which is a fact about that release and
        // not a value in its database: `fx_rate_source` is NOT NULL, so a
        // release that has the column always answers with one of its two
        // values, and a release from before #59 answers with nothing.
        ...verificationClaim(e)
      })),
      balances: (Array.isArray(budget.json?.balances) ? budget.json.balances : [])
        .map(b => ({ email: b.email, netCents: b.netCents }))
    })
  }

  // What `verify`'s floor rests on, asserted HERE, where the previous release
  // is still up and can say what went wrong. Both expenses, each with the
  // category it was filed under: those two facts are what make 22 of that
  // floor's 23 assertions reachable, so if this release reports its budget
  // differently the run stops at the producer rather than at the consumer with
  // a count nobody can explain. The twenty-third — #31's display zone — needs
  // nothing extra of the canary: every event in the snapshot carries one.
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

  // The event summaries the NEW release answers, read once. `timezone` (#31)
  // lives here rather than on the budget, and a map beats one request per event.
  const summaries = await api('GET', '/events')
  if (summaries.status !== 200 || !Array.isArray(summaries.json)) {
    abort(`GET /api/v1/events answered ${summaries.status} on the new release: ${summaries.text.slice(0, 300)}`)
  }
  const zoneNow = new Map(summaries.json.filter(e => e?.slug).map(e => [e.slug, e.timezone ?? null]))

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

      // THERE WAS AN ASSERTION HERE that each entry's `baseCurrency` was
      // untouched. It could not fail: #59's migration writes nothing to that
      // column, so it restated a tautology and still counted towards the floor
      // below — the same shape as the `totalCents` check removed further down.
      // The claim it was trying to make lives at the event level, where the
      // backfill actually writes, and is asserted after this loop.
      //
      // WHAT THE ROW CLAIMS ABOUT VERIFICATION — compared against the SNAPSHOT,
      // and not against a constant.
      //
      // This read `now.fxRateSource === 'fetched'` until #27, and the intent
      // behind it is right and is kept: a column that has to be filled for
      // every existing row has no accurate value to fill it with, `fetched` is
      // the conservative one — "nobody told us this was checked against a
      // statement" — and a migration that reached for `manual` would be
      // inventing a verification that never happened.
      //
      // BUT "NO ROW MAY BE MANUAL" WAS ONLY EVER TRUE WHILE NO RELEASE COULD
      // WRITE ONE. It passed on #59's own branch because the release it
      // replaced was `eb69fde`, which has no `fx_rate_source` column at all, so
      // the migration wrote `fetched` everywhere and "is it fetched?" was
      // trivially true. Once #59 landed on `main` the previous release began
      // legitimately writing `manual` rows — `scripts/api-smoke.sh` writes a
      // dozen — and this failed for every branch cut from that commit onwards,
      // whatever its diff. An assertion that encodes a property of WHICH
      // RELEASE HAPPENS TO BE THE BASE is stale the moment the base moves.
      //
      // The honest form of the same intent is "the migration did not change
      // this row's claim", which is what is asserted now, and it keeps biting:
      // a migration that turned a `fetched` row into a `manual` one, or that
      // rewrote or dropped the figure behind a `manual` one, fails here.
      //
      // Where the snapshot has NO claim at all — any release before #59 — there
      // is nothing for it to be unchanged from, and the original assertion is
      // exactly the right one: the fill has to be the conservative value, with
      // no stated figure invented beside it. Both halves of the guard are
      // therefore live, against different base releases.
      const claimed = verificationClaim(was)
      const claims = verificationClaim(now)
      // The migration left the claim alone: the base release had one.
      const unchanged = claims.fxRateSource === claimed.fxRateSource
        && claims.statedAmountCents === claimed.statedAmountCents
        && claims.statedCurrency === claimed.statedCurrency
      // The migration FILLED the claim, because the base release had no such
      // columns: the only honest fill is the conservative label with nothing
      // invented beside it.
      const filledConservatively = claims.fxRateSource === 'fetched'
        && claims.statedAmountCents === null
        && claims.statedCurrency === null
      assert(
        `${before.slug}/${was.title}: what it claims about verification is unchanged`,
        claimed.fxRateSource === null ? filledConservatively : unchanged,
        `was ${JSON.stringify(claimed)}, now ${JSON.stringify(claims)}`
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
    // The trip's own currency, which is where #59's backfill writes. It is
    // `null` in a snapshot only if the previous release reported none at all,
    // which it did not — the budget has carried a `currency` since #25 — so
    // this is a live check against every release this job can straddle. It is
    // the assertion a backfill that reached for a constant fails, and it covers
    // the events with no expenses as well now.
    assert(
      `${before.slug}: the trip still settles in what it settled in`,
      before.currency === null || after.currency === before.currency,
      `was ${before.currency}, now ${after.currency}`
    )

    /*
     * THE DISPLAY ZONE THE MIGRATION DID NOT INVENT (#31).
     *
     * Compared against the SNAPSHOT and never against a constant, for the
     * reason the verification claim above is: "every event is null" is a
     * property of WHICH RELEASE HAPPENS TO BE THE BASE, true only while no
     * release could write a zone, and stale the moment one can — which is the
     * shape that broke every branch cut from #59's commit until #72.
     *
     * Both halves are live against different bases. Where the snapshot has no
     * zone at all — any release before #31 — the only honest fill is NONE, and
     * a migration that defaulted every trip to the instance's clock fails here.
     * Where it has one, the migration must have left it alone.
     */
    assert(
      `${before.slug}: the migration invented no display zone for it`,
      (zoneNow.get(before.slug) ?? null) === (before.timezone ?? null),
      `was ${JSON.stringify(before.timezone ?? null)}, now ${JSON.stringify(zoneNow.get(before.slug) ?? null)}`
    )

    /*
     * AND WROTE NOTHING ON A TICKET THAT WAS ALREADY THERE (#35). Same claim as
     * the zone above and compared the same way: against the SNAPSHOT, because
     * "every ticket has no detail" is a property of which release happens to be
     * the base and goes stale the moment one can write them.
     *
     * It also catches a media row that DISAPPEARED. The migration adds a unique
     * index on `events_media (event_id, id)` — it cannot drop a row, since `id`
     * is already the primary key — but a cascade that pointed the wrong way
     * could, and a ticket quietly deleted by a migration is the worst possible
     * failure for the person holding the trip.
     *
     * ON THE CANARY THIS IS VACUOUS, and it is counted in MIN_ASSERTIONS
     * anyway: the canary is written through `/api/v1`, which has no upload
     * route, so it has no media and the honest answer for it is "nothing
     * changed about nothing". The events where it bites are the smoke suite's
     * leftovers, which include the tickets the receipt block and the ticket
     * block both upload. Asserting the vacuum is the right answer here; what it
     * must not do is go missing.
     */
    const mediaNow = new Map(((await api('GET', `/events/${before.slug}/media`)).json ?? [])
      .filter(m => m?.id).map(m => [m.id, m]))
    const wrongOnTicket = (before.media ?? []).filter((was) => {
      const now = mediaNow.get(was.id)
      if (!now) return true
      const expected = was.ticket === 'no-field' ? null : was.ticket
      return JSON.stringify(now.ticket ?? null) !== JSON.stringify(expected)
    })
    assert(
      `${before.slug}: the migration wrote nothing on a ticket that was already there`,
      wrongOnTicket.length === 0,
      wrongOnTicket
        .map(w => `${w.id} (${w.type}) was ${JSON.stringify(w.ticket)}, now `
          + `${mediaNow.has(w.id) ? JSON.stringify(mediaNow.get(w.id).ticket ?? null) : 'GONE'}`)
        .join('; ')
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
