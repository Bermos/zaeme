/**
 * THE EVENT'S DISPLAY ZONE (#31).
 *
 * `events_event.starts_at`, `events_timeline_item.starts_at` and
 * `events_itinerary_leg.departs_at` are `timestamptz` and stay that way: an
 * INSTANT, stored in UTC, sent over the wire as ISO 8601 with an offset.
 * Nothing in this file converts a stored value, and nothing in this file should
 * ever be read as a licence to. `events_event.timezone` is a LABEL that says
 * which wall clock to render those instants against — the 09:14 from Lisbon is
 * the same moment for everybody, and the only question this answers is whether
 * the itinerary says 09:14 or 10:14 to the person reading it in Zürich.
 *
 * NULL MEANS "THE VIEWER'S ZONE", which is what every screen did before this
 * existed and is the right answer for a dinner party: the people coming are
 * standing where it is happening. A zone is for the event that is somewhere
 * else.
 *
 * ── WHAT IS ACCEPTED, AND WHY THAT IS NARROWER THAN `Intl` ─────────────────
 *
 * `Intl.DateTimeFormat` accepts more than an IANA region name. It takes
 * `+02:00`, `Etc/GMT+5`, `GMT` and `UTC` — every one of them a FIXED OFFSET,
 * and every one of them a silent lie across a DST boundary, which is the one
 * case this feature exists for. A trip whose zone is `+01:00` reads correctly
 * in March and an hour wrong in April, with nothing on screen saying so; and
 * `Etc/GMT+5` is west of Greenwich, not east, which is a sign error waiting for
 * somebody who read it as an offset. So `canonicalTimezone` refuses all of
 * them and asks for a zone in one of IANA's ten GEOGRAPHIC AREAS
 * (`Europe/Lisbon`), whose DST rules ICU already knows and applies per instant.
 * That allow-list is deliberate rather than a list of exclusions: excluding
 * `Etc/` by name left `SystemV/EST5EDT` — pre-2007 US daylight rules, an hour
 * off `America/New_York` for three weeks every March — and a rule written as
 * "not these families" is a rule nobody can finish.
 *
 * The refusal is the SERVER's (`server/domain/events-data.ts` turns a null from
 * here into a 422); this module returns null and carries no h3 dependency, so
 * the host form, the server and the tests all apply one rule. That is the
 * `shared/utils/` precedent `settlement.ts` and `split-weight.ts` set.
 *
 * ── AND WHAT A ZONE THAT STOPS RESOLVING DOES ──────────────────────────────
 *
 * A stored zone reaches `Intl.DateTimeFormat` on every render, and a value it
 * refuses throws a `RangeError` — which, inside a Vue template on an SSR'd
 * invite page, is a failed page rather than a wrong time. The write side makes
 * that unreachable, but "unreachable" is a claim about today's code and not
 * about the row that is already in the database: a zone typed into psql, or one
 * a future ICU drops (`Europe/Kyiv` is only a few years old and the old name is
 * still what this Node canonicalises to), would otherwise take the page down.
 * So every formatter here FALLS BACK TO THE VIEWER'S ZONE — today's behaviour,
 * and the same thing a null zone does — rather than throwing. One defined
 * answer on both sides: refused on the way in, ignored on the way out.
 */

/**
 * THE TEN GEOGRAPHIC AREAS IANA USES, AND NOTHING ELSE — an ALLOW-LIST, which
 * is the second version of this rule and the reason for the change.
 *
 * The first version was a shape (`Area/Location`, at least one `/`, no leading
 * sign) with `Etc/` excluded by name, and its own comment said that a regex
 * "which quietly admits the one family the rule exists to exclude" is the shape
 * worth naming. It was admitting TWO: `SystemV/EST5` canonicalises and is a
 * permanent −05:00, and `SystemV/EST5EDT` follows the PRE-2007 US daylight
 * rules, so on 2026-03-15 it reads an hour off `America/New_York` — a zone that
 * is wrong for three weeks a year and right the rest of the time, which is the
 * worst kind. Excluding one family by name means asking whether there is a
 * third; naming the areas that ARE geographic ends the question.
 *
 * This list is not a guess. `Intl.supportedValuesOf('timeZone')` on this
 * runtime contains exactly these ten areas and no others, so the allow-list can
 * refuse nothing the picker offers or `timezonesForCountry` suggests — which is
 * what makes it safe to be this strict.
 *
 * What it now refuses that it used to take: the single-word country aliases and
 * the legacy country areas — `Japan`, `GB`, `Portugal`, `US/Eastern`,
 * `Brazil/East`, `W-SU`. All of them resolve, and all of them are reachable
 * only by hand-typing into an API that does not accept this field at all: the
 * one way in is the host form's picker, which lists `supportedValuesOf`.
 */
const GEOGRAPHIC_AREAS = [
  'Africa', 'America', 'Antarctica', 'Arctic', 'Asia',
  'Atlantic', 'Australia', 'Europe', 'Indian', 'Pacific'
]

/**
 * `Area/Location`, with the area being one of the ten above. The location half
 * still allows `+`/`-` because real ones use them (`GMT+0` never reaches here;
 * `America/Port-au-Prince` does).
 */
const REGION_ZONE = new RegExp(`^(?:${GEOGRAPHIC_AREAS.join('|')})(?:/[A-Za-z0-9_+-]+)+$`, 'i')

/** Longer than any IANA identifier; a bound before the string reaches ICU. */
export const MAX_TIMEZONE_LENGTH = 64

/** What a zone that is not a zone is called on screen and in a refusal. */
export const TIMEZONE_REFUSAL
  = 'That is not a time zone name. Use a region name like Europe/Lisbon — a fixed offset cannot follow a daylight-saving change.'

/**
 * The zone as it will be STORED, or null when it is not one this app will keep.
 *
 * Empty (or whitespace, or null) is not a refusal: it is "no zone", which is a
 * legitimate value meaning the viewer's own. Callers that need to tell the two
 * apart use `isBlankTimezone` first.
 *
 * CASE IS CANONICALISED AND AN ALIAS IS NOT. `europe/lisbon` differs from what
 * ICU resolves only in case, so the resolved spelling is kept and the field
 * reads `Europe/Lisbon`. `Europe/Kyiv` is a different matter: this Node
 * resolves it to `Europe/Kiev`, and storing that would put a name on the host's
 * screen that they did not choose and that is not the one the city has. Both
 * identifiers format identically — they are the same zone — so the one the
 * person typed is the one kept.
 */
export function canonicalTimezone(raw: string | null | undefined): string | null {
  const name = (raw ?? '').trim()
  if (name === '' || name.length > MAX_TIMEZONE_LENGTH) return null
  if (!REGION_ZONE.test(name)) return null
  let resolved: string
  try {
    resolved = new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone
  } catch {
    return null
  }
  // A zone in a geographic area that ICU nonetheless resolves to a fixed offset
  // would be the same lie by another spelling. Nothing does that today; this is
  // what keeps the rule true if anything ever starts.
  if (!REGION_ZONE.test(resolved)) return null
  return resolved.toLowerCase() === name.toLowerCase() ? resolved : name
}

/** True when the caller asked for "no zone" rather than for a zone. */
export function isBlankTimezone(raw: string | null | undefined): boolean {
  return (raw ?? '').trim() === ''
}

/** Whether a value can be rendered against; a stored zone is checked here, not trusted. */
export function isRenderableTimezone(zone: string | null | undefined): zone is string {
  if (!zone) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/**
 * Whether two identifiers name THE SAME zone, which is not the same question as
 * whether the two strings match.
 *
 * `Europe/Kyiv` and `Europe/Kiev` are one zone with two spellings, and this
 * module deliberately stores whichever the host typed (see `canonicalTimezone`)
 * — so every comparison between a stored value and a list that came from ICU
 * has to go through here. A `zones.includes(stored)` undoes that decision in
 * one line: it reports "not in the list", and whatever acts on that answer then
 * offers the host the alias they were spared.
 */
export function sameZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return a === b || (!a && !b)
  if (a === b) return true
  const resolve = (z: string) => {
    try {
      return new Intl.DateTimeFormat('en', { timeZone: z }).resolvedOptions().timeZone.toLowerCase()
    } catch {
      return null
    }
  }
  const ra = resolve(a)
  return ra !== null && ra === resolve(b)
}

/** The zone to hand `Intl`, or undefined for the viewer's own. See the fallback note above. */
function safeZone(zone: string | null | undefined): string | undefined {
  return isRenderableTimezone(zone) ? zone : undefined
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Format an instant against the event's wall clock — the one call every screen
 * makes, so the fallback is decided once.
 *
 * `null` for a value that is not a date, so a caller keeps whatever placeholder
 * it already showed ('—', 'Date TBD') rather than this file inventing one.
 */
export function formatInZone(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions,
  zone: string | null | undefined,
  locale = 'en-CH'
): string | null {
  const d = toDate(value)
  if (!d) return null
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: safeZone(zone) }).format(d)
}

/**
 * The sentence a card puts above a column of times: "Times are in
 * Europe/Lisbon".
 *
 * IT NAMES THE ZONE AND NOT THE ABBREVIATION, deliberately. `WEST` is true of
 * an instant, not of a trip: a week that straddles the last Sunday in October
 * is half `WEST` and half `WET`, and one heading claiming either is wrong for
 * half the itinerary — which is exactly the failure a per-event zone is
 * supposed to end. A single time that wants a stamp gets one from its own
 * instant (`timeZoneName: 'short'` on that one call).
 *
 * Null when there is no zone to name, which is the case where every screen
 * shows what it always showed and needs no heading at all.
 */
export function zoneNote(zone: string | null | undefined): string | null {
  return isRenderableTimezone(zone) ? `Times are in ${zone}` : null
}

/* ------------------------- wall-clock arithmetic -------------------------- */

/**
 * The numeric wall clock an instant shows in a zone. `h23` rather than
 * `hour12: false`, which some ICU builds render as `24` at midnight and would
 * put every midnight on the previous day.
 */
function partsInZone(at: Date, zone: string | undefined) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(at)
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second')
  }
}

/** How far the zone's wall clock is from UTC at that instant, in milliseconds. */
function offsetMsAt(at: Date, zone: string | undefined): number {
  const p = partsInZone(at, zone)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime()
}

/** `2026-07-01` as the zone sees it — the key a day heading groups on. */
export function zoneDayKey(value: string | number | Date | null | undefined, zone: string | null | undefined): string | null {
  const d = toDate(value)
  if (!d) return null
  const p = partsInZone(d, safeZone(zone))
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/** What a `<input type="datetime-local">` shows for an instant, in the zone. */
export function toZonedInputValue(value: string | number | Date | null | undefined, zone: string | null | undefined): string {
  const d = toDate(value)
  if (!d) return ''
  const p = partsInZone(d, safeZone(zone))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/**
 * A wall-clock time the host TYPED, as the instant it names in the event's zone.
 *
 * This is the half of #31 that is not display, and leaving it out would have
 * made the display half incoherent: a host in Zürich editing a Lisbon trip
 * types `09:14` into a field whose neighbours all say "Times are in
 * Europe/Lisbon", and `new Date('2026-07-01T09:14').toISOString()` would read
 * it as 09:14 in ZÜRICH — stored an hour early, shown back as 08:14, and the
 * time moving every time anybody opened the form. Storage is unchanged: what
 * goes to the server is still an ISO instant, this just reads the field against
 * the right clock.
 *
 * TWO PASSES, and the second one is the DST one. The offset has to be looked up
 * at the instant being computed, but the instant is what is being computed; the
 * first pass uses the offset at the naive guess, which is wrong for any wall
 * time within an offset's distance of a transition, and the second pass fixes
 * it. The two answers differ only in that window, which is precisely where this
 * kind of code is wrong in production and right in a test written in July.
 *
 * The two transition cases have DEFINED answers rather than accidental ones:
 *
 *  - a wall time that does not exist (the hour spring-forward skips) resolves
 *    to the instant that same wall clock names AFTER the shift — 02:30 on
 *    Zürich's spring Sunday is 03:30 CEST, one instant, forwards, never null;
 *  - a wall time that happens TWICE (the hour autumn repeats) resolves to the
 *    SECOND of them, the one on standard time — 02:30 on Zürich's autumn
 *    Sunday is 02:30 CET, not 02:30 CEST. Either is defensible and neither is
 *    guessable from reading the arithmetic, so both are pinned by a test.
 *
 * The second of those has a consequence worth stating rather than discovering:
 * a `datetime-local` field CANNOT hold the difference between the two 02:30s,
 * so opening the edit form on the earlier one and saving it untouched moves it
 * an hour later. No wall-clock widget can do better, and refusing to save would
 * be worse; `test/event-timezone.test.ts` asserts it so the round-trip test
 * beside it is not read as a promise it does not make.
 *
 * Null for anything that is not `YYYY-MM-DDTHH:mm`, so a caller sends null
 * rather than an `Invalid Date`. A date that is well-formed but does not exist
 * (`2026-02-31T10:00`) cannot throw either: with a zone `Date.UTC` rolls it
 * over, and without one the parse is guarded — see the note in the body, which
 * is the only part of this file no test here can reach.
 */
export function isoFromZonedInput(local: string | null | undefined, zone: string | null | undefined): string | null {
  const text = (local ?? '').trim()
  const m = LOCAL_INPUT.exec(text)
  if (!m) {
    const loose = toDate(text)
    return loose ? loose.toISOString() : null
  }
  const tz = safeZone(zone)
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
  if (!tz) {
    // WELL-FORMED IS NOT THE SAME AS REAL, and what `2026-02-31T10:00` does
    // here depends on the engine: V8 rolls it over to 3 March, while a
    // spec-strict parser answers Invalid Date and `toISOString()` then THROWS
    // — out of a click handler, on a browser this repository never runs a test
    // on. A `datetime-local` field cannot produce such a value, which is
    // exactly why nobody would ever find it.
    const own = toDate(text)
    return own ? own.toISOString() : null
  }
  const firstPass = wall - offsetMsAt(new Date(wall), tz)
  const settled = wall - offsetMsAt(new Date(firstPass), tz)
  return new Date(settled).toISOString()
}

/* --------------------------- choosing a zone ------------------------------ */

/**
 * What the browser says it is in — the default for a local gathering, so the
 * common case costs the host nothing. Null on the server, where there is no
 * viewer to ask and where guessing from the container's `TZ` would put the
 * hosting provider's zone on somebody's party.
 */
export function browserTimezone(): string | null {
  // Through `globalThis` rather than a bare `window`: this module is compiled
  // for the server too, where the DOM lib is not loaded and the identifier does
  // not exist at all.
  if ((globalThis as { window?: unknown }).window === undefined) return null
  return canonicalTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
}

/**
 * Every zone this runtime knows, for the picker. `Intl.supportedValuesOf` is
 * ICU's own list, so there is no table in this repository to go stale — and no
 * network, no dependency, and the same answer on both sides of SSR.
 */
export function timezoneChoices(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone').filter(z => canonicalTimezone(z) !== null)
  } catch {
    return []
  }
}

/**
 * WHAT A GEOCODED PLACE SHOULD OFFER, given the zones of its country and the
 * zone the trip already carries: the whole list, or null for "say nothing".
 *
 * This is a pure function and not three lines inside `HostPlacesCard.vue` for a
 * reason worth stating. The card is client-side — the suggestions arrive from a
 * `$fetch` and nothing in this repository drives a browser — so the smoke suite
 * can prove the SERVER answers with all twenty-nine US zones and cannot see the
 * card keeping four of them. That is exactly where the bug was: `.slice(0, 4)`
 * of an alphabetical list, which for a pin in Brooklyn is Adak, Anchorage,
 * Boise and Chicago. A check that watches the wire while the defect lives in
 * the renderer is a check that would have passed. So the decision moved here,
 * where a unit test executes the real thing.
 *
 * NOTHING IS TRUNCATED AND NOTHING IS RANKED — see `HostPlacesCard.vue` for why
 * the obvious ranking (each zone's offset against the one the pin's longitude
 * implies) was measured and thrown away.
 *
 * Null when the country has no zones, or when the trip is ALREADY in one of
 * them — compared with `sameZone`, because the stored value may be the spelling
 * the host typed while ICU lists the alias, and `includes` would re-offer a
 * trip its own zone under the name it was spared.
 */
export function zonesToOffer(zones: string[] | undefined | null, current: string | null | undefined): string[] | null {
  const all = (zones ?? []).filter(z => canonicalTimezone(z) !== null)
  if (all.length === 0) return null
  if (all.some(z => sameZone(z, current))) return null
  return all
}

/**
 * The zones of a country, for the suggestion a geocoded place makes (#32 landed
 * the search; this is what turns "Ponte 25 de Abril, Portugal" into "shall I
 * show this trip's times in Europe/Lisbon?").
 *
 * ICU KNOWS THIS ALREADY: `Intl.Locale.prototype.timeZones` is the region's
 * zones, so a country-to-zone table nobody would maintain is not needed. The
 * accessor is spelled `timeZones` in V8 and `getTimeZones()` in JavaScriptCore,
 * which is why both are tried — though every caller today is server-side, where
 * only the first exists.
 *
 * A one-zone country (CH, FR, JP) gives one answer and the card offers it. A
 * multi-zone one (PT has three, US has twenty-nine) gives a list, and the card
 * shows a few rather than pretending to know which: a trip to Portugal is
 * probably Lisbon and possibly the Azores, and the host is the one who knows.
 */
export function timezonesForCountry(countryCode: string | null | undefined): string[] {
  const cc = (countryCode ?? '').trim()
  if (!/^[A-Za-z]{2}$/.test(cc)) return []
  try {
    const locale = new Intl.Locale(`und-${cc.toUpperCase()}`) as Intl.Locale & {
      timeZones?: string[]
      getTimeZones?: () => string[]
    }
    const zones = locale.timeZones ?? locale.getTimeZones?.() ?? []
    return zones.filter(z => canonicalTimezone(z) !== null)
  } catch {
    return []
  }
}
