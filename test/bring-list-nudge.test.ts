import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  bringListGaps,
  bringListNudgeAt,
  bringListNudgeDecision,
  gapLine,
  nudgeRecipients,
  NUDGE_DELIVERY_WINDOW_MS,
  NUDGE_HOUR_LOCAL,
  type BringListNudgeFacts
} from '../server/domain/contributions'
import { STATUS_TRANSITIONS } from '../server/domain/events-data'
import { renderBringListNudgeEmail } from '../server/emails/index'
import { functions } from '../server/inngest/index'
import { toZonedInputValue } from '../shared/utils/timezone'

/**
 * NOTHING NUDGES THE FOUR UNCLAIMED DISHES THE NIGHT BEFORE (#46).
 *
 * ── WHY THIS FILE CARRIES THE WHOLE FEATURE ────────────────────────────────
 *
 * Because nothing else can. `scripts/api-smoke.sh` is curl against HTTP routes
 * and this feature has none: it is an Inngest function, delivered by a signal
 * with a future `ts`, and there is no Inngest server in CI to deliver one. The
 * only thing the smoke suite can say about it is that the BUILT server
 * registers it — one check, and it is a check about a manifest rather than
 * about behaviour.
 *
 * So the four refusals in the issue's acceptance list and the timing rule are
 * all executed here, which is also why `bringListNudgeDecision` is a pure
 * function in the domain rather than a ladder of `if`s inside the handler. A
 * refusal written inline in a background job in this repository is reachable by
 * nothing at all.
 *
 * ── THE FIXTURE, AND THE ITEM THE APP WOULD NEVER PRODUCE ──────────────────
 *
 * `SALAD` carries a stated need of 2 bowls AND a free-text amount ("two big
 * bowls") AND a claim row of zero. A fixture built only from the shapes the
 * happy path generates cannot see any of the three: a `gapLine` that reached
 * for `quantity` whenever it was set would be green over every counted item
 * that happens to have none, and a tally that treated a claim as "somebody is
 * on it" rather than as a NUMBER would call a zero-claim item finished. #45
 * shipped a data loss for exactly this reason — its copy fixture held only
 * items whose lost column was empty anyway.
 */

/* ------------------------------ the fixture ------------------------------- */

type Item = Parameters<typeof gapLine>[0]

const claims = (...quantities: number[]) =>
  quantities.map((quantityClaimed, i) => ({
    name: `Claimer ${i}`,
    email: `claimer${i}@example.com`,
    quantityClaimed,
    claimedAt: new Date('2026-06-20T10:00:00Z')
  }))

/** Six bottles wanted, four spoken for — the issue's own arithmetic. */
const WINE: Item = { title: 'Wine', quantity: null, unit: 'bottles', quantityNeeded: 6, claims: claims(3, 1) }
/** No count, nobody on it: the free-text half of the list, and its amount matters. */
const BREAD: Item = { title: 'Bread', quantity: 'two loaves', unit: null, quantityNeeded: null, claims: [] }
/** No count, somebody on it — finished, as it has been since before #44. */
const CRISPS: Item = { title: 'Crisps', quantity: null, unit: null, quantityNeeded: null, claims: claims(1) }
/** Ten of three: over-claiming is a party, not an error, and it is finished. */
const PROSECCO: Item = { title: 'Prosecco', quantity: null, unit: 'bottles', quantityNeeded: 3, claims: claims(10) }
/** A count with no unit, and nobody on it at all. */
const CUPS: Item = { title: 'Cups', quantity: null, unit: null, quantityNeeded: 18, claims: [] }
/** The shape nothing in the app writes: a count, a free text AND a zero claim. */
const SALAD: Item = { title: 'Salad', quantity: 'two big bowls', unit: 'bowls', quantityNeeded: 2, claims: claims(0) }

const LIST = [WINE, BREAD, CRISPS, PROSECCO, CUPS, SALAD]

describe('what one still-missing item reads as', () => {
  it('states the remainder, the total and the unit when a need was stated', () => {
    expect(gapLine(WINE)).toBe('Wine — 2 of 6 bottles still to go')
  })

  it('reads without a unit, because half a bring list is counted in nothing', () => {
    expect(gapLine(CUPS)).toBe('Cups — 18 of 18 still to go')
  })

  it('names the free-text amount for an item that has no count', () => {
    // The column #45 lost in a copy. A gap line of bare nouns tells somebody to
    // bring bread and not how much, which is the whole question.
    expect(gapLine(BREAD)).toBe('Bread — two loaves')
  })

  it('is the bare title when there is neither a count nor an amount', () => {
    expect(gapLine({ title: 'Napkins', quantity: null, unit: null, quantityNeeded: null, claims: [] }))
      .toBe('Napkins')
  })

  it('says nothing about an item somebody has claimed', () => {
    expect(gapLine(CRISPS)).toBeNull()
  })

  it('says nothing about an over-claimed item', () => {
    expect(gapLine(PROSECCO)).toBeNull()
  })

  it('says nothing about a need of zero, which is a statement and not a blank', () => {
    expect(gapLine({ title: 'Ice', quantity: null, unit: 'bags', quantityNeeded: 0, claims: [] })).toBeNull()
  })

  it('counts a claim of zero as zero, and ignores the free text on a counted item', () => {
    // Both halves in one assertion on purpose: the wrong answers are "Salad —
    // two big bowls" (free text preferred over the count) and null (a claim row
    // read as "somebody is on it" rather than as a number).
    expect(gapLine(SALAD)).toBe('Salad — 2 of 2 bowls still to go')
  })
})

describe('the gaps, and only the gaps', () => {
  it('names what is missing in list order and leaves out what is not', () => {
    expect(bringListGaps(LIST)).toEqual([
      'Wine — 2 of 6 bottles still to go',
      'Bread — two loaves',
      'Cups — 18 of 18 still to go',
      'Salad — 2 of 2 bowls still to go'
    ])
  })

  it('is empty for a list where everything is spoken for', () => {
    expect(bringListGaps([CRISPS, PROSECCO])).toEqual([])
  })

  it('is empty for a list with nothing on it', () => {
    expect(bringListGaps([])).toEqual([])
  })

  it('is the whole list when nobody has claimed anything', () => {
    expect(bringListGaps([BREAD, CUPS])).toHaveLength(2)
  })
})

/* ----------------------------- who hears about it ----------------------------- */

const rsvpRow = (
  id: string,
  status: 'yes' | 'maybe' | 'no' | 'cheering',
  over: {
    guestName?: string | null
    guestEmail?: string | null
    user?: { name: string | null, email: string } | null
    invite?: { token: string } | null
  } = {}
) => ({
  rsvp: {
    id,
    status,
    guestName: over.guestName ?? null,
    guestEmail: over.guestEmail ?? null
  },
  user: over.user ?? null,
  invite: over.invite ?? null
})

describe('the people who said yes', () => {
  const rows = [
    rsvpRow('r1', 'yes', { user: { name: 'Ada', email: 'Ada@Example.com' }, invite: { token: 'tok-ada' } }),
    rsvpRow('r2', 'yes', { guestName: 'Bo', guestEmail: 'bo@example.com' }),
    rsvpRow('r3', 'yes', { guestEmail: 'ADA@example.com', guestName: 'Ada again' }),
    rsvpRow('r4', 'maybe', { guestEmail: 'mo@example.com' }),
    rsvpRow('r5', 'no', { guestEmail: 'nope@example.com' }),
    rsvpRow('r6', 'cheering', { guestEmail: 'faraway@example.com' }),
    rsvpRow('r7', 'yes', {})
  ]

  it('takes the yes-RSVPs and nobody else', () => {
    expect(nudgeRecipients(rows).map(r => r.email)).toEqual(['ada@example.com', 'bo@example.com'])
  })

  it('leaves out "cheering from afar", who is explicitly not coming', () => {
    // Bermos/zaeme#87: `summariseRsvps().headcount` counts this status as
    // attending. Reusing that number here would mail a shopping list to
    // somebody who told the host they could not come.
    expect(nudgeRecipients(rows).map(r => r.email)).not.toContain('faraway@example.com')
  })

  it('leaves out a maybe, which is the narrower of the two readings', () => {
    expect(nudgeRecipients(rows).map(r => r.email)).not.toContain('mo@example.com')
  })

  it('mails one person once, whichever case they typed their address in', () => {
    expect(nudgeRecipients(rows).filter(r => r.email === 'ada@example.com')).toHaveLength(1)
  })

  it('prefers the account name and carries the invite token back to the list', () => {
    const [ada, bo] = nudgeRecipients(rows)
    expect(ada).toMatchObject({ rsvpId: 'r1', name: 'Ada', inviteToken: 'tok-ada' })
    expect(bo).toMatchObject({ rsvpId: 'r2', name: 'Bo', inviteToken: null })
  })

  it('drops a yes with no address anywhere on it', () => {
    expect(nudgeRecipients(rows).map(r => r.rsvpId)).not.toContain('r7')
  })
})

/* --------------------------------- the timing --------------------------------- */

const iso = (at: Date | null) => at?.toISOString() ?? null

describe('18:00 the evening before, on the event\'s own clock', () => {
  it('is 18:00 in Zürich for a Zürich party', () => {
    // 2026-07-01T07:00Z is 09:00 CEST on the 1st; the evening before is
    // 2026-06-30 18:00 CEST, which is 16:00Z.
    expect(iso(bringListNudgeAt('2026-07-01T07:00:00Z', 'Europe/Zurich'))).toBe('2026-06-30T16:00:00.000Z')
  })

  it('is a different instant for the same start in a different zone', () => {
    // The same moment is 03:00 EDT on the 1st in New York, so the evening
    // before is 2026-06-30 18:00 EDT — 22:00Z, six hours later than Zürich.
    expect(iso(bringListNudgeAt('2026-07-01T07:00:00Z', 'America/New_York'))).toBe('2026-06-30T22:00:00.000Z')
  })

  it('counts back from the event\'s LOCAL day, not from the UTC one', () => {
    // 2026-07-01T23:30Z is already 01:30 on the 2nd in Zürich, so the evening
    // before is the 1st and not the 30th. A version that split the day on UTC
    // would nudge a full day early.
    expect(iso(bringListNudgeAt('2026-07-01T23:30:00Z', 'Europe/Zurich'))).toBe('2026-07-01T16:00:00.000Z')
  })

  it('rolls back over the start of a month', () => {
    expect(iso(bringListNudgeAt('2026-03-01T10:00:00Z', 'Europe/Zurich'))).toBe('2026-02-28T17:00:00.000Z')
  })

  it('rolls back over the start of a year', () => {
    expect(iso(bringListNudgeAt('2026-01-01T10:00:00Z', 'Europe/Zurich'))).toBe('2025-12-31T17:00:00.000Z')
  })

  it('takes the offset at the NUDGE, not at the event', () => {
    // Zürich springs forward on 2026-03-29. A party on the 30th is nudged on
    // the 29th at 18:00 CEST (16:00Z); a party on the 29th is nudged on the
    // 28th at 18:00 CET (17:00Z). One hour apart, and a single fixed offset
    // gets one of the two wrong.
    expect(iso(bringListNudgeAt('2026-03-30T17:00:00Z', 'Europe/Zurich'))).toBe('2026-03-29T16:00:00.000Z')
    expect(iso(bringListNudgeAt('2026-03-29T17:00:00Z', 'Europe/Zurich'))).toBe('2026-03-28T17:00:00.000Z')
  })

  it('lands at 18:00 on the viewer\'s clock when the event names no zone', () => {
    const at = bringListNudgeAt('2026-07-01T07:00:00Z', null)
    expect(toZonedInputValue(at, null).endsWith(`T${String(NUDGE_HOUR_LOCAL).padStart(2, '0')}:00`)).toBe(true)
  })

  it('is always before the event, for every hour of the day it could start at', () => {
    for (let hour = 0; hour < 24; hour++) {
      const start = new Date(Date.UTC(2026, 6, 1, hour, 0, 0))
      for (const zone of ['Europe/Zurich', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
        const at = bringListNudgeAt(start, zone)
        expect(at, `${zone} @ ${hour}:00Z`).not.toBeNull()
        expect(at!.getTime(), `${zone} @ ${hour}:00Z`).toBeLessThan(start.getTime())
        // …and not so far before that it is a second reminder rather than a
        // nudge: at most two days, at least six hours.
        expect(start.getTime() - at!.getTime()).toBeLessThanOrEqual(48 * 3600_000)
        expect(start.getTime() - at!.getTime()).toBeGreaterThanOrEqual(6 * 3600_000)
      }
    }
  })

  it('is null when there is no start to count back from', () => {
    expect(bringListNudgeAt(null, 'Europe/Zurich')).toBeNull()
    expect(bringListNudgeAt(undefined, null)).toBeNull()
    expect(bringListNudgeAt('not a date', 'Europe/Zurich')).toBeNull()
  })

  it('moves by at least the delivery window whenever the local day changes', () => {
    // THE ARITHMETIC BEHIND `NUDGE_DELIVERY_WINDOW_MS`, executed rather than
    // reasoned. The window has to be narrow enough that a real reschedule can
    // never hide inside it, and the claim that justifies six hours is that the
    // smallest move which changes this function's answer is a WHOLE DAY —
    // because it reads the event's local calendar day, not its clock. The
    // narrowest such day is a 23-hour one, the spring-forward Sunday, and this
    // walks a year of them in four zones including two that observe the shift
    // on different dates.
    let narrowest = Infinity
    for (const zone of ['Europe/Zurich', 'America/New_York', 'Pacific/Auckland', 'Asia/Kolkata']) {
      for (let day = 0; day < 365; day++) {
        const a = bringListNudgeAt(new Date(Date.UTC(2026, 0, 1 + day, 12, 0, 0)), zone)
        const b = bringListNudgeAt(new Date(Date.UTC(2026, 0, 2 + day, 12, 0, 0)), zone)
        narrowest = Math.min(narrowest, Math.abs(b!.getTime() - a!.getTime()))
      }
    }
    expect(narrowest).toBe(23 * 3600_000)
    expect(NUDGE_DELIVERY_WINDOW_MS).toBeLessThan(narrowest)
  })
})

/* ------------------------------- the decision ------------------------------- */

/**
 * 30 June 16:00Z is 18:00 in Zürich — exactly when a party starting at 09:00
 * CEST on 1 July is due its nudge. Every case below moves one thing away from
 * that.
 */
const NOW = Date.parse('2026-06-30T16:00:00.000Z')

const plan = (over: Partial<BringListNudgeFacts> = {}): BringListNudgeFacts => ({
  status: 'published',
  startsAt: new Date('2026-07-01T07:00:00Z'),
  timezone: 'Europe/Zurich',
  itemCount: LIST.length,
  gaps: bringListGaps(LIST),
  recipients: [{ rsvpId: 'r1', email: 'ada@example.com', name: 'Ada', inviteToken: 'tok-ada' }],
  ...over
})

const decide = (over: Partial<BringListNudgeFacts> = {}, mailConfigured = true) =>
  bringListNudgeDecision(plan(over), { now: NOW, mailConfigured })

describe('whether to send at all', () => {
  it('sends when there are gaps, people and a transport', () => {
    expect(decide()).toEqual({ send: true, reason: null, gaps: 4, recipients: 1 })
  })

  it('sends nothing for a cancelled event — this is the whole cancellation mechanism', () => {
    // Nothing cancels the scheduled signal: `cancelOn` cancels a RUN, and a
    // signal queued with a future `ts` has no run until it is delivered. The
    // re-read is what stops the mail, so it is asserted rather than assumed.
    expect(decide({ status: 'cancelled' })).toMatchObject({ send: false, reason: 'status-cancelled' })
  })

  it('sends nothing for an event that never got published, or was completed', () => {
    expect(decide({ status: 'draft' })).toMatchObject({ send: false, reason: 'status-draft' })
    expect(decide({ status: 'completed' })).toMatchObject({ send: false, reason: 'status-completed' })
  })

  it('sends nothing when the start has been moved into the past', () => {
    expect(decide({ startsAt: new Date('2026-06-01T07:00:00Z') }))
      .toMatchObject({ send: false, reason: 'already-started' })
    expect(decide({ startsAt: null })).toMatchObject({ send: false, reason: 'no-start' })
  })

  it('sends nothing on the OLD date when the party has been moved later', () => {
    // THE REGRESSION THIS RUNG EXISTS FOR, in the shape it was executed in.
    // Published for 1 July, moved to 1 September: the signal still lands on
    // 30 June, and without this rung every yes-RSVP was told what was
    // unclaimed for a party two months away — while the mail's own `When:`
    // line correctly read September, so it arrived as an obvious mistake.
    expect(decide({ startsAt: new Date('2026-09-01T07:00:00Z') }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
  })

  it('catches a move of a single day, which is the smallest one that moves the nudge', () => {
    // The nudge reads the event's local DAY, so a day is the smallest move that
    // changes its answer at all — and it has to be caught, or the window is
    // wide enough to let a real reschedule through.
    expect(decide({ startsAt: new Date('2026-07-02T07:00:00Z') }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
    expect(decide({ startsAt: new Date('2026-06-30T20:00:00Z') }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
  })

  it('does NOT call a move within the same local day a reschedule', () => {
    // 1 July at 22:00 CEST is the same evening-before nudge as 1 July at 09:00,
    // because the rule is the local day and not the clock. Treating this as a
    // reschedule would delete the nudge for a host who nudged the start by an
    // hour.
    expect(decide({ startsAt: new Date('2026-07-01T20:00:00Z') }))
      .toMatchObject({ send: true, reason: null })
  })

  it('still sends when the delivery is late, which is what the window is for', () => {
    // A queue backlog or a retried run must not become silence on the one night
    // this feature exists for.
    expect(bringListNudgeDecision(plan(), { now: NOW + 5 * 3600_000, mailConfigured: true }))
      .toMatchObject({ send: true })
    expect(bringListNudgeDecision(plan(), { now: NOW - 5 * 3600_000, mailConfigured: true }))
      .toMatchObject({ send: true })
  })

  it('stops sending once the delivery is further out than the window', () => {
    expect(bringListNudgeDecision(plan(), { now: NOW + 7 * 3600_000, mailConfigured: true }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
    expect(bringListNudgeDecision(plan(), { now: NOW - 7 * 3600_000, mailConfigured: true }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
  })

  it('reads the zone as well as the start, because the zone decides the instant', () => {
    // Same start, relabelled Auckland: 18:00 the evening before is now a
    // different instant by more than the window, so this delivery is not it.
    expect(decide({ timezone: 'Pacific/Auckland' }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
  })

  it('calls a start that no longer resolves a reschedule rather than crashing', () => {
    // An `Invalid Date` is truthy, so it walks past `no-start`, and every
    // comparison against it is false, so it walks past `already-started` too.
    // Without this rung it reached the send loop.
    expect(decide({ startsAt: new Date('nonsense') }))
      .toMatchObject({ send: false, reason: 'rescheduled' })
  })

  it('prefers "already-started" over "rescheduled" for a party that has happened', () => {
    // Both are true of an event moved into the past. The more specific fact is
    // the one worth logging.
    expect(decide({ startsAt: new Date('2026-06-01T07:00:00Z') }))
      .toMatchObject({ reason: 'already-started' })
  })

  it('sends nothing when the list is COMPLETE', () => {
    expect(decide({ itemCount: 2, gaps: [] })).toMatchObject({ send: false, reason: 'list-complete' })
  })

  it('sends nothing when the list is EMPTY, and says so differently', () => {
    // Two facts, two reasons, one silence. A party with no bring list is not a
    // party that forgot; collapsing the two would lose that distinction from
    // every log this job ever writes.
    expect(decide({ itemCount: 0, gaps: [] })).toMatchObject({ send: false, reason: 'no-bring-list' })
  })

  it('sends nothing when nobody has said yes', () => {
    expect(decide({ recipients: [] })).toMatchObject({ send: false, reason: 'nobody-said-yes' })
  })

  it('no-ops quietly on an instance with no mail transport', () => {
    // Not a throw and not a failure: a refusal like any other, carrying what it
    // WOULD have said so the decision stays visible on an instance that cannot
    // send — which is every instance before its mail is configured, and the one
    // CI runs the smoke suite against.
    expect(decide({}, false)).toEqual({ send: false, reason: 'no-mail-transport', gaps: 4, recipients: 1 })
  })

  it('reports the counts whichever way it decides', () => {
    expect(decide({ status: 'cancelled' })).toMatchObject({ gaps: 4, recipients: 1 })
  })
})

/* ------------------------------ once per event ------------------------------ */

describe('once per event, not a campaign', () => {
  it('can reach "published" at most once, so at most one nudge is ever scheduled', () => {
    // The nudge is scheduled by `events/event.published`, which `setEventStatus`
    // dispatches on the transition INTO `published`. "Once per event" is
    // therefore a property of this table and not of anything in the job: only
    // draft and polling reach published, and the two ways out of published are
    // both terminal. A sixth status that re-opened the cycle fails here.
    const reachPublished = Object.entries(STATUS_TRANSITIONS)
      .filter(([, next]) => next.includes('published'))
      .map(([from]) => from)
    expect(reachPublished.sort()).toEqual(['draft', 'polling'])
    for (const from of STATUS_TRANSITIONS.published ?? []) {
      expect(STATUS_TRANSITIONS[from], `${from} must be terminal`).toEqual([])
    }
  })
})

/* -------------------------------- the message -------------------------------- */

describe('the message names what is missing and nothing else', () => {
  const gaps = bringListGaps(LIST)

  it('lists every gap', async () => {
    const { text } = await renderBringListNudgeEmail({
      recipientName: 'Ada',
      eventTitle: 'Midsummer potluck',
      eventSlug: 'midsummer-potluck',
      startsAt: new Date('2026-07-01T07:00:00Z'),
      timezone: 'Europe/Zurich',
      gaps
    })
    for (const line of gaps) expect(text).toContain(line)
  })

  it('does NOT list what somebody is already bringing', async () => {
    // The mutation this catches is the obvious one: hand the template the whole
    // bring list instead of the gaps. Everything else about the mail would look
    // right, and the person reading it would have to diff it themselves — which
    // is the work nobody was doing, which is why the issue exists.
    const { text } = await renderBringListNudgeEmail({
      eventTitle: 'Midsummer potluck',
      eventSlug: 'midsummer-potluck',
      startsAt: new Date('2026-07-01T07:00:00Z'),
      gaps
    })
    expect(text).not.toContain('Crisps')
    expect(text).not.toContain('Prosecco')
  })

  it('counts the gaps in its own opening line, and reads for one', async () => {
    const many = await renderBringListNudgeEmail({
      eventTitle: 'Midsummer potluck', eventSlug: 'midsummer-potluck', gaps
    })
    expect(many.text).toContain('4 things on the bring list')
    const one = await renderBringListNudgeEmail({
      eventTitle: 'Midsummer potluck', eventSlug: 'midsummer-potluck', gaps: ['Bread — two loaves']
    })
    expect(one.text).toContain('One thing on the bring list')
  })
})

/* ----------------------------- and it is wired up ----------------------------- */

describe('the job is registered and scheduled', () => {
  it('is one of the functions `/api/inngest` serves', () => {
    // The manifest, executed rather than grepped: a function written and never
    // added to `functions` is served by nothing and would be invisible to every
    // other check in this file.
    expect(functions.map(f => f.id())).toEqual([
      'rsvp-confirmed',
      'event-published',
      'event-reminder',
      'event-cancelled',
      'bring-list-nudge'
    ])
  })

  it('is scheduled by event.published, at the time this file pins', () => {
    // A SOURCE ASSERTION, and worth saying what it is not: nothing in this
    // repository executes `eventPublished`, so this proves the call site is
    // WRITTEN with the right arguments and the right signal name, not that it
    // runs. The arithmetic it calls is executed above; the delivery is
    // Inngest's.
    const src = readFileSync(new URL('../server/inngest/functions/event-published.ts', import.meta.url), 'utf8')
    expect(src).toContain('bringListNudgeAt(ev.startsAt, ev.timezone)')
    expect(src).toContain('\'events/bring-list.nudge\'')
  })
})
