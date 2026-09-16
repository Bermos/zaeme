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

const { canonicalTimezone, formatInZone, isBlankTimezone, isoFromZonedInput, rezoneInputValue, sameZone, timezoneChoices, zonesToOffer, timezonesForCountry, toZonedInputValue, zoneDayKey, zoneNote }
  = await import('../shared/utils/timezone')

/**
 * Imported after the clock is moved, for the same reason: it formats against
 * the ambient zone when an event has none, and that reading has to be the
 * third one too.
 */
const { formatEventWhen } = await import('../server/emails/format')

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

  it('refuses EVERY family that is not one of the ten geographic areas', () => {
    // THE SECOND VERSION OF THIS RULE. The first excluded `Etc/` by name and
    // still admitted `SystemV/`: `SystemV/EST5` is a permanent −05:00, and
    // `SystemV/EST5EDT` follows the PRE-2007 US daylight rules, so it agrees
    // with `America/New_York` for most of the year and is an hour out for three
    // weeks every March — a zone that is wrong just rarely enough not to be
    // reported. Both resolve happily through `Intl`.
    expect(canonicalTimezone('SystemV/EST5')).toBeNull()
    expect(canonicalTimezone('SystemV/EST5EDT')).toBeNull()
    // …and this is the fact that makes that one an hour wrong rather than
    // merely obsolete, asserted rather than asserted-about.
    const march = '2026-03-15T17:00:00Z'
    expect(formatInZone(march, HHMM, 'SystemV/EST5EDT')).not.toBe(formatInZone(march, HHMM, 'America/New_York'))
    // The single-word aliases and the legacy country areas go with them. Every
    // one resolves; none is reachable except by hand-typing past a picker.
    for (const legacy of ['US/Eastern', 'Brazil/East', 'Canada/Eastern', 'Mexico/General', 'Japan', 'GB', 'GB-Eire', 'Portugal', 'W-SU', 'NZ', 'Navajo']) {
      expect(canonicalTimezone(legacy), legacy).toBeNull()
    }
  })

  it('refuses nothing the picker offers or a geocoded place suggests', () => {
    // WHAT MAKES THE ALLOW-LIST SAFE TO BE THAT STRICT, and the check that has
    // to go red if a future ICU adds an eleventh area: every zone this app can
    // put in front of a host must be one it will store. `timezoneChoices` is
    // the picker; `timezonesForCountry` is the geocoded suggestion.
    const offered = timezoneChoices()
    expect(offered.length).toBeGreaterThan(300)
    expect(offered).toContain('Europe/Lisbon')
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      expect(canonicalTimezone(zone), zone).toBe(zone)
    }
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

  it('knows an alias names the same zone, which a string comparison does not', () => {
    // The other half of keeping the host's spelling: every comparison between a
    // stored value and a list ICU produced has to go through `sameZone`, or the
    // decision is undone by one `includes`. `HostPlacesCard` asks exactly this
    // question — "is the trip already in one of this country's zones?" — and
    // answered it with `includes` until the review, so a trip on `Europe/Kyiv`
    // was re-offered its own zone spelled `Europe/Kiev`.
    expect(sameZone('Europe/Kyiv', 'Europe/Kiev')).toBe(true)
    expect(sameZone('Asia/Kolkata', 'Asia/Calcutta')).toBe(true)
    expect(sameZone('Europe/Lisbon', 'Europe/Lisbon')).toBe(true)
    expect(sameZone('Europe/Kyiv', 'Europe/Lisbon')).toBe(false)
    expect(sameZone('Europe/Kyiv', null)).toBe(false)
    expect(sameZone(null, null)).toBe(true)
    // A value ICU cannot resolve is not the same as anything, including itself
    // spelled differently — and it does not throw.
    expect(sameZone('America/Nowhere', 'America/Nowhere')).toBe(true)
    expect(sameZone('America/Nowhere', 'Europe/Lisbon')).toBe(false)
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
    // NOT ASSERTED HERE, and worth saying why: `2026-02-31T10:00` is
    // well-formed and not real, and what it does depends on the ENGINE. V8
    // rolls it over to 3 March; a spec-strict parser answers Invalid Date,
    // whose `toISOString()` throws. `isoFromZonedInput` guards for the second
    // case, but nothing in this repository runs an engine that takes it — an
    // expectation either way would be a claim about V8 dressed up as one about
    // the function.
  })

  it('leaves an instant that already carries its offset alone', () => {
    // Not everything reaching this function comes from a `datetime-local`: an
    // ISO string with an offset is already a moment and must not be re-read
    // against anybody's wall clock.
    expect(isoFromZonedInput('2026-07-01T08:14:00Z', 'Europe/Lisbon')).toBe('2026-07-01T08:14:00.000Z')
    expect(isoFromZonedInput('2026-07-01T09:14:00+01:00', 'Pacific/Chatham')).toBe('2026-07-01T08:14:00.000Z')
  })

  /*
   * AND WHAT AN OPEN FORM DOES WHEN THE ZONE MOVES UNDER IT (#35, found by
   * #77's review).
   *
   * A `datetime-local` seeded with `toZonedInputValue(instant, A)` holds a wall
   * clock in A. If the event's zone becomes B while the form is open, the field
   * still SAYS the A reading and `isoFromZonedInput(field, B)` resolves it as a
   * B wall clock — a different instant, on a field nobody touched. Measured on
   * the host ticket card: 22:59Z seeded as `23:59` in Europe/Lisbon, saved
   * after a switch to America/New_York as 03:59Z the next morning.
   *
   * `rezoneInputValue` is the conversion, and it lives here rather than in the
   * card for the reason the whole of #31 exists: nothing in this repository
   * drives a browser, so a decision inside a `watch` is executed by nothing.
   */
  describe('re-reading an open field when the event zone changes', () => {
    it('keeps the instant and changes the reading', () => {
      // The measured bug, as an assertion. The field says 23:59 Lisbon; after
      // the switch it must say 18:59 New York, which is the SAME moment — and
      // must not say 23:59, which is what an unconverted field would keep.
      const moved = rezoneInputValue('2026-07-01T23:59', 'Europe/Lisbon', 'America/New_York')
      expect(moved).toBe('2026-07-01T18:59')
      expect(isoFromZonedInput(moved, 'America/New_York')).toBe('2026-07-01T22:59:00.000Z')
      // …and the instant is the one it started as, which is the whole claim.
      expect(isoFromZonedInput(moved, 'America/New_York'))
        .toBe(isoFromZonedInput('2026-07-01T23:59', 'Europe/Lisbon'))
    })

    it('crosses a calendar day when the new zone is far enough away', () => {
      // A same-day pair cannot tell "converted" from "re-read the time and kept
      // the date", which is the fixture question #31's review taught. Chatham
      // is +12:45, so this also proves the quarter-hour survives.
      expect(rezoneInputValue('2026-07-01T23:59', 'Europe/Lisbon', 'Pacific/Chatham'))
        .toBe('2026-07-02T11:44')
    })

    it('is identity when the zone has not actually moved', () => {
      // `Europe/Kyiv` and `Europe/Kiev` are one zone with two spellings, and a
      // host picking the alias must not have every open field shifted.
      expect(rezoneInputValue('2026-07-01T23:59', 'Europe/Lisbon', 'Europe/Lisbon'))
        .toBe('2026-07-01T23:59')
      expect(rezoneInputValue('2026-07-01T23:59', 'Europe/Kyiv', 'Europe/Kiev'))
        .toBe('2026-07-01T23:59')
    })

    it('reads a null zone as the reader\'s own, on both sides', () => {
      // Clearing the zone is a value (#31), so it has to convert like any
      // other change: out of Chatham, which is where this file stands.
      expect(rezoneInputValue('2026-07-02T11:44', null, 'Europe/Lisbon'))
        .toBe('2026-07-01T23:59')
      expect(rezoneInputValue('2026-07-01T23:59', 'Europe/Lisbon', null))
        .toBe('2026-07-02T11:44')
    })

    it('leaves an empty field empty rather than inventing a time', () => {
      // A caller re-seeding a blank field has nothing better to put there, and
      // a form that fills itself in is the one thing #35 may not do.
      expect(rezoneInputValue('', 'Europe/Lisbon', 'America/New_York')).toBe('')
      expect(rezoneInputValue(null, 'Europe/Lisbon', 'America/New_York')).toBe('')
      expect(rezoneInputValue(undefined, 'Europe/Lisbon', 'America/New_York')).toBe('')
      expect(rezoneInputValue('not a date', 'Europe/Lisbon', 'America/New_York')).toBe('')
    })
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

  it('names EVERY zone the country has, because a shortened list is a wrong one', () => {
    // THE CARD SHOWS ALL OF THESE AND RANKS NONE OF THEM, and this is the
    // assertion that keeps it honest. It used to show `.slice(0, 4)` of an
    // ALPHABETICAL list, which for the United States is Adak, Anchorage, Boise
    // and Chicago — a pin in New York was offered none of them and Adak is five
    // hours out. Portugal fits in four, which is why the stub, both fixtures
    // and every check missed it.
    expect(timezonesForCountry('us')).toContain('America/New_York')
    expect(timezonesForCountry('us')).toContain('America/Los_Angeles')
    expect(timezonesForCountry('us').length).toBeGreaterThan(4)
    expect(timezonesForCountry('au')).toContain('Australia/Sydney')
    expect(timezonesForCountry('br')).toContain('America/Sao_Paulo')
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

  it('offers the WHOLE list, because the card is the half no smoke check can see', () => {
    // THE DECISION THE CARD MAKES, executed. `HostPlacesCard` is client-side —
    // the suggestions arrive from a `$fetch` and nothing in this repository
    // drives a browser — so the smoke suite can prove the SERVER answered with
    // all twenty-nine US zones and cannot see the card keeping four. That is
    // where the bug was, so the decision lives in a function a test can call.
    const us = zonesToOffer(timezonesForCountry('us'), null)
    expect(us).not.toBeNull()
    expect(us!.length).toBe(timezonesForCountry('us').length)
    expect(us!.length).toBeGreaterThan(4)
    expect(us).toContain('America/New_York')
    // Alphabetically this one sits far below the four that used to be shown.
    expect(us).toContain('America/Los_Angeles')
    // Every offered zone is one the write side will accept — a suggestion the
    // host cannot take is a button that 422s.
    for (const zone of us!) expect(canonicalTimezone(zone), zone).toBe(zone)
  })

  it('says nothing when the trip is already in one of that country\'s zones', () => {
    // From the second pin onwards this is the usual case, and it is the one the
    // alias decision can undo: a trip stored as the host's `Europe/Kyiv` is in
    // Ukraine's list under ICU's `Europe/Kiev`, and a string comparison would
    // re-offer it its own zone spelled the way it was spared.
    expect(zonesToOffer(timezonesForCountry('pt'), 'Europe/Lisbon')).toBeNull()
    expect(zonesToOffer(timezonesForCountry('ua'), 'Europe/Kyiv')).toBeNull()
    expect(zonesToOffer(timezonesForCountry('ua'), 'Europe/Kiev')).toBeNull()
    // …and a trip in a different country still gets the offer.
    expect(zonesToOffer(timezonesForCountry('pt'), 'Europe/Zurich')).toContain('Europe/Lisbon')
  })

  it('offers nothing rather than failing when the geocoder named no country', () => {
    // A pin in the middle of the sea, or a row cached before `addressdetails`
    // was asked for. Search still works; it just makes no suggestion.
    expect(timezonesForCountry(null)).toEqual([])
    expect(timezonesForCountry('')).toEqual([])
    expect(timezonesForCountry('xx')).toEqual([])
    expect(timezonesForCountry('Portugal')).toEqual([])
    expect(zonesToOffer([], 'Europe/Lisbon')).toBeNull()
    expect(zonesToOffer(undefined, null)).toBeNull()
  })
})

/* ------------------------------ outgoing mail ----------------------------- */

describe('an email says which clock it is stating', () => {
  it('states the time in the event\'s zone, stamped', async () => {
    // THE SURFACE THAT NEEDS THE LABEL MOST: a mail lands in an inbox with no
    // card around it, is read days later and somewhere else, and is the thing
    // people act on. Before #31 it stated the start in whatever zone the
    // SERVER's container was set to, unlabelled — so the invite email for a
    // Lisbon trip said 08:14 while the invite page it links to said 09:14 WEST.
    const when = formatEventWhen('2027-07-01T08:14:00Z', null, 'Europe/Lisbon')
    expect(when).toContain('09:14')
    expect(when).toContain('WEST')
    // …and the ambient reading — which is what it used to send — is neither.
    expect(when).not.toContain('20:59')
  })

  it('stamps the START\'s own abbreviation and never the span\'s', () => {
    // A trip across the last Sunday in October is half WEST and half WET, so
    // the stamp is taken at the instant it labels. Lisbon shifts at 01:00 UTC
    // on 2026-10-25; these two straddle it.
    expect(formatEventWhen('2026-10-24T12:00:00Z', null, 'Europe/Lisbon')).toContain('WEST')
    expect(formatEventWhen('2026-10-26T12:00:00Z', null, 'Europe/Lisbon')).toContain('WET')
  })

  it('decides "same day" on the event\'s calendar, not the server\'s', () => {
    // A party from 22:00 to 23:30 in Lisbon is one evening. On this file's
    // ambient clock (Chatham, +12:45) both instants are already the next day
    // and a server-calendar comparison would still call it one day — the case
    // that separates them is the one where the two disagree, so assert the
    // shape: one day prints one date, two days print two.
    const oneEvening = formatEventWhen('2027-07-01T21:00:00Z', '2027-07-01T22:30:00Z', 'Europe/Lisbon')
    expect(oneEvening).toBe('1 July 2027 at 22:00 – 23:30 WEST')
    const twoDays = formatEventWhen('2027-07-01T21:00:00Z', '2027-07-02T09:00:00Z', 'Europe/Lisbon')
    expect(twoDays).toContain('2 July 2027')
  })

  it('renders exactly as it did before when the event has no zone', () => {
    // Criterion one, on this surface too.
    const iso = '2027-07-01T08:14:00Z'
    expect(formatEventWhen(iso, null, null)).toBe(new Date(iso).toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' }))
    expect(formatEventWhen(iso, null, null)).not.toContain('WEST')
    // A zone nobody can render falls back the same way rather than throwing
    // inside a background job that has already decided to send.
    expect(formatEventWhen(iso, null, 'America/Nowhere')).toBe(formatEventWhen(iso, null, null))
    expect(formatEventWhen(null, null, 'Europe/Lisbon')).toBeNull()
  })
})
