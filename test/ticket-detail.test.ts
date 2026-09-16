/**
 * What a ticket says, as the lines a person reads at a barrier (#35).
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * The ticket list is rendered by a CLIENT-SIDE fetch — media URLs are
 * short-lived signatures, so `app/pages/i/[token].vue` loads them `onMounted`
 * and they are in no SSR'd HTML. `pnpm smoke:api` can therefore prove the
 * server answers `"seat":"41A"` and is structurally incapable of noticing the
 * card rendering it against the wrong clock, or not rendering it at all. That
 * is exactly the hole #31's review found in `.slice(0, 4)` of a zone list, and
 * the remedy is the same one: the decision lives in a pure function in
 * `shared/utils/`, and this executes the real thing.
 *
 * ── WHY THE CLOCK IS MOVED BEFORE ANYTHING IS IMPORTED ────────────────────
 *
 * A TIMEZONE BUG IS INVISIBLE TO A TEST THAT RUNS IN THE ZONE IT ASSUMES. CI
 * runs in UTC, so a ticket valid until 23:59 UTC reads as "23:59" to an
 * implementation that honours `Europe/London` in winter AND to one that
 * dropped the zone on the floor. The ambient zone is moved to
 * `Pacific/Chatham` (+12:45 / +13:45) for the same reason
 * `test/event-timezone.test.ts` does: it is off by hours AND by a quarter of
 * an hour, so no expected value below can accidentally coincide with the
 * ambient rendering.
 *
 * ── AND WHY THE FIXTURES ARE NOT PORTUGUESE ───────────────────────────────
 *
 * #31's zone shortlist was wrong for every multi-zone country and right for
 * Portugal, which was the country in the stub and in both test files — so ask
 * what a fixture makes impossible. The zoned assertions here use
 * `Europe/Lisbon` only where the point is the summer/winter abbreviation, and
 * the discriminating ones use `America/Los_Angeles` against a ticket whose
 * instant falls on a DIFFERENT CALENDAR DAY there, which is the failure mode
 * a same-day fixture cannot see.
 */
import { afterAll, describe, expect, it } from 'vitest'

const AMBIENT_TZ = process.env.TZ
process.env.TZ = 'Pacific/Chatham'
afterAll(() => {
  if (AMBIENT_TZ === undefined) delete process.env.TZ
  else process.env.TZ = AMBIENT_TZ
})

const { seatLine, ticketDetailLines, validityLine } = await import('../shared/utils/ticket-detail')

/** A full ticket, for the tests that take things away from it. */
const FULL = {
  bookingRef: 'XY7Q2M',
  carrier: 'SBB',
  seat: '41A',
  coach: '12',
  travellerName: 'Ana Silva',
  validFrom: '2026-07-01T07:00:00Z',
  validUntil: '2026-07-01T22:59:00Z',
  note: 'Window, facing forwards'
}

/* --------------------------- the ambient control -------------------------- */

describe('the test itself is standing somewhere else', () => {
  it('runs in a zone that is neither UTC nor any zone asserted below', () => {
    // If this stops being true, every zoned expectation in this file becomes
    // satisfiable by an implementation that ignores its `zone` argument.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Chatham')
    // 22:59Z is 11:44 the NEXT DAY here — the reading every assertion below
    // must not produce.
    expect(validityLine({ validUntil: FULL.validUntil }, null))
      .toBe('Valid until Thu, 2 Jul, 11:44 GMT+12:45')
  })
})

/* ------------------------ nothing filled in is legal ----------------------- */

describe('a ticket with nothing filled in is still a ticket', () => {
  it('renders no lines at all when there is no detail row', () => {
    expect(ticketDetailLines(null, 'Europe/Lisbon')).toEqual([])
    expect(ticketDetailLines(undefined, 'Europe/Lisbon')).toEqual([])
  })

  it('renders no lines for a detail row whose every field is blank', () => {
    // THE CASE THE ISSUE INSISTS ON. A row exists — somebody opened the form
    // and cleared it, or typed one field and removed it again — and it must
    // read exactly like no row at all, because the PDF is what gets you
    // through the barrier and the detail is a convenience on top of it.
    const empty = {
      bookingRef: null,
      carrier: null,
      seat: null,
      coach: null,
      travellerName: null,
      validFrom: null,
      validUntil: null,
      note: null
    }
    expect(ticketDetailLines(empty, 'Europe/Lisbon')).toEqual([])
    // …and it is the SAME answer as no row, which is what makes the two
    // indistinguishable on screen while staying distinguishable in the data.
    expect(ticketDetailLines(empty, 'Europe/Lisbon')).toEqual(ticketDetailLines(null, 'Europe/Lisbon'))
  })

  it('treats whitespace as nothing typed, not as something typed', () => {
    // A field a browser autofilled with a space is a field somebody left
    // alone; rendering ` ` as a line would put a blank row under a ticket.
    expect(ticketDetailLines({ seat: '   ', carrier: '\t', note: '\n' }, null)).toEqual([])
  })
})

/* ----------------------------- the seat line ------------------------------ */

describe('the line a conductor asks for', () => {
  it('is "coach 12, seat 41A" when both are known', () => {
    expect(seatLine(FULL)).toBe('coach 12, seat 41A')
  })

  it('is one half alone, with no stray comma', () => {
    // The ordinary case for a bus, a plane with no coaches and an open ticket.
    expect(seatLine({ seat: '41A' })).toBe('seat 41A')
    expect(seatLine({ coach: '12' })).toBe('coach 12')
  })

  it('is nothing when neither is known', () => {
    expect(seatLine({ bookingRef: 'XY7Q2M' })).toBeNull()
    expect(seatLine(null)).toBeNull()
  })
})

/* ------------------------- the clock at the barrier ------------------------ */

describe('a ticket valid until 23:59 means 23:59 where the barrier is', () => {
  it('renders the validity in the EVENT zone, not the reader\'s', () => {
    // 22:59Z is 23:59 in Lisbon in July and 11:44 the next day where this test
    // is standing. The wrong answer and the right one differ by a day, an hour
    // and a quarter of an hour, so nothing here can coincide.
    expect(validityLine(FULL, 'Europe/Lisbon'))
      .toBe('Valid Wed, 1 Jul, 08:00 WEST until Wed, 1 Jul, 23:59 WEST')
  })

  it('names the clock it is in, per instant', () => {
    // The stamp is what makes the line readable on its own — a ticket is held
    // up at a gate with nothing else from the page in view, so a `zoneNote`
    // heading four cards away is not a label.
    expect(validityLine({ validUntil: FULL.validUntil }, 'Europe/Lisbon'))
      .toBe('Valid until Wed, 1 Jul, 23:59 WEST')
  })

  it('stamps each end from its OWN instant across a daylight change', () => {
    // Lisbon's autumn change is 25 October 2026. A ticket spanning it is half
    // WEST and half WET, and one trailing abbreviation would be wrong for one
    // of its own ends — which is the reason both halves carry their own.
    const spanning = { validFrom: '2026-10-24T09:00:00Z', validUntil: '2026-10-26T09:00:00Z' }
    const line = validityLine(spanning, 'Europe/Lisbon')!
    expect(line).toContain('WEST')
    expect(line).toContain('WET')
    expect(line).toBe('Valid Sat, 24 Oct, 10:00 WEST until Mon, 26 Oct, 09:00 WET')
  })

  it('crosses the calendar day in a zone behind the instant', () => {
    // THE FIXTURE THAT IS NOT PORTUGUESE. Lisbon is one hour off UTC in
    // summer, so a same-day Portuguese fixture cannot tell "render in the
    // event zone" from "render the date in UTC and the time in the zone".
    // 04:30Z on 2 July is 21:30 on 1 JULY in Los Angeles — a different day,
    // which is the reading a barrier acts on.
    expect(validityLine({ validUntil: '2026-07-02T04:30:00Z' }, 'America/Los_Angeles'))
      .toBe('Valid until Wed, 1 Jul, 21:30 GMT-7')
  })

  it('falls back to the reader\'s clock when the event has no zone', () => {
    // Which is what every screen in this app does without one, and is the
    // right answer for a gathering where the people coming are standing.
    expect(validityLine({ validFrom: '2026-07-01T07:00:00Z' }, null))
      .toBe('Valid from Wed, 1 Jul, 19:45 GMT+12:45')
  })

  it('falls back rather than throwing on a zone that stopped resolving', () => {
    // A stored zone reaches `Intl` on every render, and a value it refuses
    // throws a RangeError — inside a Vue template that is a failed page, not a
    // wrong time. `formatInZone` already decides this; asserting it here is
    // what stops a "tidier" formatter being introduced beside it.
    expect(validityLine({ validUntil: FULL.validUntil }, 'Mars/Olympus'))
      .toBe('Valid until Thu, 2 Jul, 11:44 GMT+12:45')
  })

  it('says nothing about a validity nobody wrote down', () => {
    expect(validityLine({ seat: '41A' }, 'Europe/Lisbon')).toBeNull()
    expect(validityLine({ validFrom: 'not a date' }, 'Europe/Lisbon')).toBeNull()
  })
})

/* ---------------------------- the whole reading --------------------------- */

describe('everything worth reading, in the order somebody reads it', () => {
  it('puts the carrier and the reference together, then the seat', () => {
    expect(ticketDetailLines(FULL, 'Europe/Lisbon')).toEqual([
      'SBB · XY7Q2M',
      'coach 12, seat 41A',
      'Ana Silva',
      'Valid Wed, 1 Jul, 08:00 WEST until Wed, 1 Jul, 23:59 WEST',
      'Window, facing forwards'
    ])
  })

  it('labels a bare reference so it is not mistaken for a name', () => {
    expect(ticketDetailLines({ bookingRef: 'XY7Q2M' }, null)).toEqual(['Booking XY7Q2M'])
    // …and does not label it when the carrier is there to say what it is.
    expect(ticketDetailLines({ bookingRef: 'XY7Q2M', carrier: 'SBB' }, null)).toEqual(['SBB · XY7Q2M'])
    expect(ticketDetailLines({ carrier: 'SBB' }, null)).toEqual(['SBB'])
  })

  it('drops only what is missing, keeping the rest in order', () => {
    // A ticket with a seat and nothing else is the common real one: a booking
    // made by somebody else, forwarded as a PDF, with the seat read off it.
    expect(ticketDetailLines({ seat: '41A', note: 'Quiet coach' }, null)).toEqual([
      'seat 41A',
      'Quiet coach'
    ])
  })

  it('accepts a Date as readily as the string JSON leaves behind', () => {
    // The card reads a `$fetch` result (strings); a server-side caller would
    // hand it `Date`s straight off the column. One rule for both.
    const asDate = ticketDetailLines({ validUntil: new Date(FULL.validUntil) }, 'Europe/Lisbon')
    const asString = ticketDetailLines({ validUntil: FULL.validUntil }, 'Europe/Lisbon')
    expect(asDate).toEqual(asString)
    expect(asDate).toEqual(['Valid until Wed, 1 Jul, 23:59 WEST'])
  })
})
