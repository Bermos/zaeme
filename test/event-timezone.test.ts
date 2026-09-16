/**
 * The event's display zone (#31) — the rule, the rendering and the DST edges.
 *
 * ── WHY THIS FILE MOVES THE CLOCK BEFORE IT IMPORTS ANYTHING ───────────────
 *
 * A TIMEZONE BUG IS INVISIBLE TO A TEST THAT RUNS IN THE ZONE IT ASSUMES. CI
 * runs in UTC, and `formatInZone('…T08:14:00Z', 'Europe/Lisbon')` is `09:14` in
 * July — which is also what an implementation that IGNORED the zone entirely
 * would answer, because Lisbon is one hour off UTC that month. Every assertion
 * below would pass against code that dropped the feature on the floor.
 *
 * So the ambient zone is moved to a THIRD one, and deliberately to
 * `Pacific/Chatham`: it is +12:45 / +13:45, so an implementation that forgets
 * the zone is wrong by hours AND by a quarter of an hour, and a comparison that
 * happens to line up cannot line up here. Every expected value below is
 * therefore different from both the stored instant and the ambient rendering,
 * which is the only arrangement in which these assertions mean anything.
 *
 * `process.env.TZ` is read lazily by Node (v13+) for both `Date` and `Intl`, so
 * setting it before the first use works; vitest isolates each file in its own
 * fork, and it is restored afterwards anyway so that nothing depends on that.
 */
import { afterAll, describe, expect, it } from 'vitest'

const AMBIENT_TZ = process.env.TZ
process.env.TZ = 'Pacific/Chatham'
afterAll(() => {
  if (AMBIENT_TZ === undefined) delete process.env.TZ
  else process.env.TZ = AMBIENT_TZ
})

const { canonicalTimezone, formatInZone, isBlankTimezone, isoFromZonedInput, timezonesForCountry, toZonedInputValue, zoneDayKey, zoneNote }
  = await import('../shared/utils/timezone')

/** Minutes and hours, the way every screen asks for them. */
const HHMM = { hour: '2-digit', minute: '2-digit' } as const

/* --------------------------- the ambient control -------------------------- */

describe('the test itself is standing somewhere else', () => {
  it('runs in a zone that is neither UTC nor any zone asserted below', () => {
    // If this ever stops being true, every expectation in this file becomes
    // satisfiable by an implementation that ignores its `zone` argument.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Chatham')
    expect(formatInZone('2026-07-01T08:14:00Z', HHMM, null)).toBe('20:59')
  })
})

/* ------------------------------ what is kept ------------------------------ */

describe('what may be stored as an event zone', () => {
  it('keeps a named region zone', () => {
    expect(canonicalTimezone('Europe/Lisbon')).toBe('Europe/Lisbon')
    expect(canonicalTimezone('Pacific/Chatham')).toBe('Pacific/Chatham')
    expect(canonicalTimezone('America/Argentina/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires')
    expect(canonicalTimezone('  Europe/Zurich  ')).toBe('Europe/Zurich')
  })

  it('folds case to the spelling ICU uses', () => {
    // A host who types it in lower case gets the field back reading
    // `Europe/Lisbon`, not `europe/lisbon`, on every screen afterwards.
    expect(canonicalTimezone('europe/lisbon')).toBe('Europe/Lisbon')
    expect(canonicalTimezone('EUROPE/LISBON')).toBe('Europe/Lisbon')
  })

  it('keeps the name the person chose when ICU only has an older alias for it', () => {
    // This Node resolves `Europe/Kyiv` to `Europe/Kiev` and `Asia/Kolkata` to
    // `Asia/Calcutta`. They are the same zones and format identically, so
    // storing ICU's answer would put a name on the host's screen that they did
    // not type and that the city does not use.
    expect(canonicalTimezone('Europe/Kyiv')).toBe('Europe/Kyiv')
    expect(canonicalTimezone('Asia/Kolkata')).toBe('Asia/Kolkata')
    // …and both still render, which is the only thing that makes keeping them safe.
    expect(formatInZone('2026-07-01T08:14:00Z', HHMM, 'Europe/Kyiv')).toBe('11:14')
  })

  it('refuses a fixed offset, however it is spelled', () => {
    // THIS IS THE SET THE RULE EXISTS FOR, and `Intl.DateTimeFormat` accepts
    // every one of them. A trip labelled `+01:00` reads correctly in March and
    // an hour wrong in April with nothing on screen saying so, and `Etc/GMT+5`
    // is five hours WEST of Greenwich, which is the opposite of how anybody
    // reading it would take it.
    for (const bad of ['+02:00', '-05:00', '+0200', 'Etc/GMT+5', 'Etc/GMT-3', 'Etc/UTC', 'Etc/Zulu', 'UTC', 'GMT', 'Z']) {
      expect(canonicalTimezone(bad), bad).toBeNull()
    }
  })

  it('refuses a name that is not a zone at all', () => {
    // The NUL is built rather than written: a literal one makes git treat this
    // whole file as a binary blob, which is not a thing to discover in a diff.
    const withNul = `Europe/Lisbon${String.fromCharCode(0)}`
    for (const bad of ['America/Nowhere', 'local', 'Factory', 'Europe', 'Europe/', '/Lisbon', withNul, 'Europe/Lisbon; drop table']) {
      expect(canonicalTimezone(bad), bad).toBeNull()
    }
    // Longer than any identifier, refused before it reaches ICU.
    expect(canonicalTimezone('Europe/'.concat('x'.repeat(200)))).toBeNull()
  })

  it('tells "no zone" apart from "not a zone"', () => {
    // Both come back as null from `canonicalTimezone`, and they are opposite
    // answers: one is a value the host chose and one is a refusal. The domain
    // asks `isBlankTimezone` first, which is what stops clearing the field
    // returning a 422.
    expect(canonicalTimezone('')).toBeNull()
    expect(canonicalTimezone('   ')).toBeNull()
    expect(isBlankTimezone('')).toBe(true)
    expect(isBlankTimezone('   ')).toBe(true)
    expect(isBlankTimezone(null)).toBe(true)
    expect(isBlankTimezone('America/Nowhere')).toBe(false)
  })
})

/* ------------------------------- rendering -------------------------------- */

describe('an event abroad reads in its own zone', () => {
  it('shows the Lisbon 09:14 as 09:14 to somebody standing elsewhere', () => {
    // The acceptance criterion, from a third zone. The instant is the same one
    // in all three columns; only the label moves.
    const departure = '2026-07-01T08:14:00Z'
    expect(formatInZone(departure, HHMM, 'Europe/Lisbon')).toBe('09:14')
    expect(formatInZone(departure, HHMM, 'Europe/Zurich')).toBe('10:14')
    expect(formatInZone(departure, HHMM, null)).toBe('20:59')
  })

  it('renders exactly as before when the event has no zone', () => {
    // Criterion one: null is not a new behaviour, it is the old one.
    const iso = '2026-07-01T08:14:00Z'
    expect(formatInZone(iso, HHMM, null)).toBe(new Date(iso).toLocaleTimeString('en-CH', HHMM))
    expect(zoneNote(null)).toBeNull()
  })

  it('falls back to the reader\'s own clock rather than throwing on a zone it cannot use', () => {
    // The write side refuses these, so this is about the row already in the
    // database — one typed into psql, or one a future ICU stops knowing. On an
    // SSR'd invite page a `RangeError` here is a failed page, not a wrong time.
    expect(formatInZone('2026-07-01T08:14:00Z', HHMM, 'America/Nowhere')).toBe('20:59')
    expect(zoneNote('America/Nowhere')).toBeNull()
    expect(zoneDayKey('2026-07-01T08:14:00Z', 'America/Nowhere')).toBe('2026-07-01')
  })

  it('names the zone and never an abbreviation that is only true for half the trip', () => {
    // `WEST` is a fact about an instant. A week across the last Sunday in
    // October is half `WEST` and half `WET`, so the card heading names the zone
    // and the abbreviation is stamped per time, from that time's own instant.
    expect(zoneNote('Europe/Lisbon')).toBe('Times are in Europe/Lisbon')
    const summer = formatInZone('2026-07-01T08:14:00Z', { ...HHMM, timeZoneName: 'short' }, 'Europe/Lisbon')
    const winter = formatInZone('2026-01-15T09:14:00Z', { ...HHMM, timeZoneName: 'short' }, 'Europe/Lisbon')
    expect(summer).toContain('WEST')
    expect(winter).toContain('WET')
    expect(winter).not.toContain('WEST')
  })

  it('groups a day by the event\'s calendar, not the reader\'s', () => {
    // The itinerary's day headings. A 23:30 ferry out of Lisbon is Wednesday
    // night there and Thursday lunchtime in Chatham: render the time in Lisbon
    // and the heading in Chatham and the itinerary files a correct time under
    // the wrong date, which is worse than the bug this feature fixes.
    const lateFerry = '2026-07-01T22:30:00Z'
    expect(zoneDayKey(lateFerry, 'Europe/Lisbon')).toBe('2026-07-01')
    expect(zoneDayKey(lateFerry, null)).toBe('2026-07-02')
    expect(zoneDayKey(null, 'Europe/Lisbon')).toBeNull()
  })
})

/* --------------------------- the DST transition --------------------------- */

describe('a daylight-saving boundary inside the trip', () => {
  /**
   * Europe/Lisbon shifts at 01:00 UTC on 2026-03-29: WET (+0) becomes WEST
   * (+1). These two instants are the 09:14 departure on the Saturday and the
   * 09:14 departure on the Monday, and they are ONE HOUR APART IN UTC because
   * that is what a DST shift means.
   */
  const saturday = '2026-03-28T09:14:00.000Z'
  const monday = '2026-03-30T08:14:00.000Z'

  it('shows both sides of it as the times they are', () => {
    // The criterion in one line: the boundary does not shift the times either
    // side of it. An implementation that applied one offset to the whole trip
    // gets exactly one of these two right.
    expect(formatInZone(saturday, HHMM, 'Europe/Lisbon')).toBe('09:14')
    expect(formatInZone(monday, HHMM, 'Europe/Lisbon')).toBe('09:14')
    // And they really are different instants, so this is not two readings of
    // one moment agreeing with itself.
    expect(new Date(monday).getTime() - new Date(saturday).getTime()).toBe(2 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)
  })

  it('reads a typed time back as the instant it names, on both sides', () => {
    // The editing half. The host types `09:14` on both days; the two have to
    // land an hour apart in UTC, or every itinerary written across a transition
    // is an hour out on one side of it.
    expect(isoFromZonedInput('2026-03-28T09:14', 'Europe/Lisbon')).toBe(saturday)
    expect(isoFromZonedInput('2026-03-30T09:14', 'Europe/Lisbon')).toBe(monday)
  })

  it('round-trips a stored instant through the form without moving it', () => {
    // Filling the form and saving it again, untouched, must change nothing.
    // The two directions being derived from the same offset lookup is what
    // makes this hold; two independent conversions drift exactly here.
    for (const zone of ['Europe/Lisbon', 'Europe/Zurich', 'Pacific/Chatham', null]) {
      for (const iso of [saturday, monday, '2026-03-29T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-12-24T18:00:00.000Z']) {
        expect(isoFromZonedInput(toZonedInputValue(iso, zone), zone), `${zone} ${iso}`).toBe(iso)
      }
    }
  })

  it('cannot round-trip the hour that happens twice, and says which one it keeps', () => {
    // THE ONE INSTANT A `datetime-local` FIELD CANNOT HOLD. Lisbon's clock
    // reads 01:30 at both 00:30 UTC (WEST) and 01:30 UTC (WET) on 2026-10-25,
    // so the field shows `01:30` for either and the string it hands back names
    // both. Reading it lands on the second — the same rule as a typed one —
    // which means opening the edit form on the FIRST of the pair and saving it
    // untouched moves it an hour later.
    //
    // That is a property of the widget and not a defect to hide: no wall-clock
    // field can distinguish the two, and the alternative (refusing to save)
    // would be worse. It is asserted so that nobody reads the test above as a
    // promise it does not make.
    const first = '2026-10-25T00:30:00.000Z'
    const second = '2026-10-25T01:30:00.000Z'
    expect(toZonedInputValue(first, 'Europe/Lisbon')).toBe(toZonedInputValue(second, 'Europe/Lisbon'))
    expect(isoFromZonedInput(toZonedInputValue(first, 'Europe/Lisbon'), 'Europe/Lisbon')).toBe(second)
    expect(isoFromZonedInput(toZonedInputValue(second, 'Europe/Lisbon'), 'Europe/Lisbon')).toBe(second)
  })

  it('gives the hour that does not exist a defined answer, forwards', () => {
    // Zürich springs forward 02:00 -> 03:00 on 2026-03-29, so 02:30 is a wall
    // time that never happens. It resolves to the instant that clock reads
    // after the shift — 03:30 CEST — rather than to null or to an invalid date.
    const typed = isoFromZonedInput('2026-03-29T02:30', 'Europe/Zurich')
    expect(typed).toBe('2026-03-29T01:30:00.000Z')
    expect(formatInZone(typed, HHMM, 'Europe/Zurich')).toBe('03:30')
  })

  it('gives the hour that happens twice a defined answer, the second one', () => {
    // Zürich falls back 03:00 -> 02:00 on 2026-10-25, so 02:30 happens twice:
    // 00:30 UTC on summer time and 01:30 UTC on standard time. This picks the
    // second. Either is defensible; what matters is that it is pinned rather
    // than whatever the arithmetic happened to do that week.
    const typed = isoFromZonedInput('2026-10-25T02:30', 'Europe/Zurich')
    expect(typed).toBe('2026-10-25T01:30:00.000Z')
    expect(formatInZone(typed, { ...HHMM, timeZoneName: 'short' }, 'Europe/Zurich')).toContain('CET')
  })

  it('reads a typed time against the reader\'s own clock when there is no zone', () => {
    // No zone is today's behaviour, here too: `2026-07-01T09:14` means 09:14
    // where the browser is, which in this file is Chatham.
    expect(isoFromZonedInput('2026-07-01T09:14', null)).toBe(new Date('2026-07-01T09:14').toISOString())
    expect(isoFromZonedInput('', 'Europe/Lisbon')).toBeNull()
    expect(isoFromZonedInput('not a date', 'Europe/Lisbon')).toBeNull()
  })

  it('leaves an instant that already carries its offset alone', () => {
    // Not everything reaching this function comes from a `datetime-local`: an
    // ISO string with an offset is already a moment and must not be re-read
    // against anybody's wall clock.
    expect(isoFromZonedInput('2026-07-01T08:14:00Z', 'Europe/Lisbon')).toBe('2026-07-01T08:14:00.000Z')
    expect(isoFromZonedInput('2026-07-01T09:14:00+01:00', 'Pacific/Chatham')).toBe('2026-07-01T08:14:00.000Z')
  })
})

/* ------------------------- the geocoded suggestion ------------------------ */

describe('the zone a geocoded place offers', () => {
  it('answers the zones of a country from ICU rather than a table', () => {
    // Portugal has three and the host is the one who knows which — which is why
    // the card offers a list and never sets one.
    expect(timezonesForCountry('pt')).toContain('Europe/Lisbon')
    expect(timezonesForCountry('pt')).toContain('Atlantic/Azores')
    expect(timezonesForCountry('pt').length).toBeGreaterThan(1)
    // One-zone countries are the easy case and the common one.
    expect(timezonesForCountry('ch')).toEqual(['Europe/Zurich'])
    expect(timezonesForCountry('JP')).toEqual(['Asia/Tokyo'])
  })

  it('offers every zone it names as one that may actually be stored', () => {
    // A suggestion the host cannot accept would be a button that 422s. The
    // list is filtered through the same rule the write side applies.
    for (const cc of ['pt', 'ch', 'us', 'br', 'in', 'au']) {
      for (const zone of timezonesForCountry(cc)) {
        expect(canonicalTimezone(zone), `${cc} ${zone}`).toBe(zone)
      }
    }
  })

  it('offers nothing rather than failing when the geocoder named no country', () => {
    // A pin in the middle of the sea, or a row cached before `addressdetails`
    // was asked for. Search still works; it just makes no suggestion.
    expect(timezonesForCountry(null)).toEqual([])
    expect(timezonesForCountry('')).toEqual([])
    expect(timezonesForCountry('xx')).toEqual([])
    expect(timezonesForCountry('Portugal')).toEqual([])
  })
})
