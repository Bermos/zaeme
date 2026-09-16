import { eq, lt } from 'drizzle-orm'
import { createError } from 'h3'
import { useDb } from './db'
import { geocodeCache } from '../database/schema/geocode'
import { publicOrigin } from '../utils/public-url'
import { normaliseCoordinates, type OsmType } from './places'
import { assertPlanner, loadEventBySlug } from './permissions'
import { timezonesForCountry } from '../../shared/utils/timezone'

/**
 * SEARCHING FOR A PLACE INSTEAD OF TYPING ITS NAME (#32).
 *
 * #30 gave a place `lat`/`lng` and left them nullable, because "Ana's flat" is
 * a place and nobody will ever geocode it. This is the other half: for the
 * places that ARE on the map, a planner types "ponte 25 de abril" and gets the
 * bridge, with coordinates that go straight into `numeric(9, 6)`.
 *
 * THE BROWSER NEVER CALLS THE GEOCODER. Everything here runs on the server, for
 * three reasons that are not interchangeable: the usage policy below is a
 * promise only a server can keep, a cache shared by the whole instance is worth
 * more than one cache per tab, and the outbound request carries this instance's
 * identity rather than a visitor's IP address.
 *
 * ── WHICH GEOCODER, AND WHY ────────────────────────────────────────────────
 *
 * NOMINATIM (`nominatim.openstreetmap.org`), the reference geocoder over
 * OpenStreetMap's own data. The issue offers Photon as the friendlier
 * alternative and it very nearly won; Nominatim took it on three points:
 *
 *  - its `osm_type` values are `node`/`way`/`relation`, which is EXACTLY the
 *    enum #30 put on `events_place.osm_type`. Photon answers `N`/`W`/`R` and
 *    assembles an address from parts, so choosing it means maintaining two
 *    translations whose failure mode is a silently mis-typed reference;
 *  - REVERSE geocoding is the half of this issue that Photon does differently.
 *    "Dropping a pin should name a place" wants the address OF A POINT, which
 *    is Nominatim's own operation; Photon's reverse is a nearest-feature
 *    search, which answers a different question and sometimes a surprising one;
 *  - its policy is WRITTEN DOWN (one request a second, an identifying
 *    `User-Agent`, cache your results), so it can be met exactly and shown to
 *    have been met. "Please be fair" cannot be.
 *
 * The shape below is deliberately provider-shaped rather than Nominatim-shaped:
 * `GeocoderProvider` is two functions returning `PlaceSuggestion[]`, and
 * swapping Photon in means writing a second one and changing the constant at
 * the bottom. Nothing above that line knows which geocoder answered.
 *
 * ── THE USAGE POLICY IS A REQUIREMENT, NOT ADVICE ──────────────────────────
 *
 * Nominatim blocks instances that ignore it, and being blocked is not a bug
 * anybody would see in a log — it is a search box that stopped working.
 *
 *  - the `User-Agent` names zäme and this instance's `BASE_URL`, which is both
 *    the identification the policy asks for and the way to contact whoever runs
 *    it. `userAgent()` below is the only place it is built;
 *  - AT MOST ONE REQUEST PER SECOND, enforced by `rateGate` — a token bucket in
 *    this module, not a debounce in the browser. The debounce in
 *    `HostPlacesCard.vue` is a courtesy that saves requests nobody wanted; it
 *    cannot keep a promise, because the second planner typing at the same
 *    moment is a second browser with its own timer. This gate is what is
 *    actually between the instance and the policy;
 *  - RESULTS ARE CACHED for thirty days in `zaeme_geocode_cache`, keyed on the
 *    normalised query. In normal use the rate limit is therefore unreachable:
 *    a group planning a trip asks about a dozen places, once;
 *  - a provider that answers 429 or 403 has told us to stop, so `rateGate`
 *    stops — for five minutes, without asking again, INCLUDING the callers
 *    already asleep in the queue when the refusal arrived. Retrying into a
 *    refusal is how a rate limit becomes a ban, and three of them arriving over
 *    the next three seconds is the shape that mistake actually takes;
 *  - `ZAEME_GEOCODER_URL` is the lever over all of it (see `geocoderBase`):
 *    unset means Nominatim, CI points it at a stub so a test suite never sends
 *    live traffic under this software's User-Agent, and an instance that has to
 *    stop calling right now points it at an address that refuses connections.
 *
 * ── DEGRADING ──────────────────────────────────────────────────────────────
 *
 * A geocoder that is down, slow, or rate-limiting means "search is unavailable,
 * type the name" and NEVER a failed page, a 500, or an empty list that reads as
 * "no matches". Those last two are the ones worth separating: "we could not
 * ask" and "we asked and there is no such place" want opposite things from the
 * person at the keyboard, and a single empty array says the wrong one half the
 * time. So every answer here carries a `status`, the route answers 200 in both
 * cases, and `HostPlacesCard.vue` renders two different sentences.
 *
 * A place with no coordinates at all stays a first-class state (#30). Nothing
 * in this file is on the path of adding one.
 */

/* --------------------------------- shapes --------------------------------- */

/** One thing a geocoder offered, in the shape `events_place` stores. */
export interface PlaceSuggestion {
  /** What to call it — "Ponte 25 de Abril". */
  name: string
  /** The full address line, which is what goes in `events_place.address`. */
  address: string | null
  /** Already rounded to the six decimals the column holds. */
  lat: number
  lng: number
  osmType: OsmType | null
  osmId: string | null
  /** What OpenStreetMap calls it — `bridge`, `hotel`, `city`. May be null. */
  category: string | null
  /**
   * The ISO-3166-1 alpha-2 country this landed in, lowercased as Nominatim
   * sends it. Null when the geocoder did not say — an ocean, or an answer this
   * instance cached before `addressdetails` was asked for.
   *
   * It is CACHED and `timeZones` below is not, and that split is deliberate:
   * this is what the geocoder said, which keeps for thirty days like every
   * other field here, while the zones of a country are ICU's answer and are
   * better re-derived than frozen.
   */
  countryCode: string | null
  /**
   * The zones that country has (#31), derived from `countryCode` on the way
   * out. One entry for CH, FR or JP; three for PT; twenty-nine for the US —
   * which is why this is a LIST offered as a suggestion and never a zone set
   * behind the host's back.
   */
  timeZones?: string[]
}

/**
 * Why search cannot be used at this moment. Three reasons and not one, because
 * they are three different things to say and one of them is temporary in a way
 * the person can feel ("try again in a moment" vs "this instance cannot reach
 * the geocoder at all").
 *
 * THE PERSON AT THE KEYBOARD IS NOT THE AUDIENCE FOR THIS. Every one of the
 * three renders as one sentence on the card — "search is unavailable, type the
 * name" — because there is nothing a planner can do about any of them. The
 * audience is whoever runs the instance, through the log line
 * `reportUnavailable` writes: `geocoder_rate_limited` means OpenStreetMap has
 * told this deployment to stop, which needs a person, and the other two do not.
 * A field nothing reads would be a comment pretending to be an enum.
 */
export type GeocodeUnavailable = 'geocoder_unreachable' | 'geocoder_rate_limited' | 'geocoder_busy'

/**
 * WHAT A SEARCH ANSWERS, and the discriminant is `status` rather than the HTTP
 * code: an unreachable geocoder is an ordinary, expected state of this feature,
 * exactly as `fetchFxRate` returning null is an ordinary state of the budget.
 * Answering 503 would make the browser's `$fetch` throw, which is how a search
 * box turns into a failed page.
 */
export interface GeocodeAnswer {
  status: 'ok' | 'unavailable'
  /** Null when `status` is `ok`. */
  reason: GeocodeUnavailable | null
  /** The normalised query, as it was asked — the cache key's readable half. */
  query: string
  /** Empty and `status: 'ok'` means "no such place", which is an answer. */
  results: PlaceSuggestion[]
  /** True when nothing left this process. The acceptance criterion reads it. */
  cached: boolean
  provider: string
  /** ODbL requires this on screen wherever the data is shown. */
  attribution: string
}

/** The seam a second geocoder is written against. Two functions, no state. */
export interface GeocoderProvider {
  readonly name: string
  readonly attribution: string
  search(query: string): Promise<PlaceSuggestion[]>
  reverse(lat: number, lng: number): Promise<PlaceSuggestion[]>
}

/** A stored answer, and when it stops being usable. */
export interface CachedGeocode {
  results: PlaceSuggestion[]
  expiresAt: Date
}

/**
 * Where answers are kept. The production store is the table; the tests hand in
 * a `Map`, which is what lets the cache POLICY — the two ttls, the expiry, the
 * fact that a failure is never written — be proved without a Postgres.
 */
export interface GeocodeCacheStore {
  read(key: string): Promise<CachedGeocode | null>
  write(entry: { key: string, provider: string, kind: GeocodeKind, query: string, results: PlaceSuggestion[], expiresAt: Date }): Promise<void>
  sweep(now: Date): Promise<void>
}

export type GeocodeKind = 'search' | 'reverse'

/* ------------------------------ normalisation ----------------------------- */

/** Below this a query is not a place name; above it, it is not a query. */
const MIN_QUERY_LENGTH = 2
const MAX_QUERY_LENGTH = 160

/**
 * The query as it is both SENT and KEYED — one string, so a cache hit and the
 * request it would have made can never be about subtly different things.
 *
 * Case-folded and whitespace-collapsed because "Ponte 25 de Abril", "ponte 25
 * de abril" and "  Ponte  25 de   Abril " are one question to any geocoder and
 * three rows in a cache keyed on the raw text. NFC because a browser can send
 * "Zürich" as `u` + combining diaeresis and a keyboard sends the composed
 * character: the same word, two byte strings, and — being a cache key — two
 * separate requests for the same answer.
 *
 * `foldQuery` is the folding on its own, with no opinion about length;
 * `normaliseQuery` adds the bounds and returns null outside them. They are two
 * functions because THE TWO WAYS OF BEING OUT OF BOUNDS ARE OPPOSITE ADVICE: a
 * single null told somebody who pasted a paragraph to "type at least 2
 * characters", which is the one thing that cannot help them.
 */
export function foldQuery(raw: string): string {
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * The folded query, or null when there is nothing to search for; the caller
 * turns that into a refusal rather than an empty answer, so "type more" never
 * reads as "no such place".
 */
export function normaliseQuery(raw: string): string | null {
  const q = foldQuery(raw)
  if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) return null
  return q
}

/**
 * How precisely a dropped pin is keyed: five decimals, about a metre.
 *
 * The stored column holds six (~11 cm), and keying the cache at that precision
 * would mean every pin is its own row — two people pointing at the same door
 * differ in the sixth decimal. One metre is finer than any building and coarse
 * enough that "the same pin" is the same key. The ROUNDED pair is what the
 * provider is asked about too, so the cached answer is an answer to the
 * question that was actually sent.
 */
const REVERSE_KEY_DP = 5

export function roundForReverse(value: number): number {
  return Number(value.toFixed(REVERSE_KEY_DP))
}

/**
 * `<provider>:<kind>:<query>` — the whole identity of an answer.
 *
 * The provider is in the key because a swap must not serve Photon's shape from
 * Nominatim's rows, and the kind is in it because `reverse` and `search` are
 * different questions that can otherwise produce the same text.
 */
export function geocodeCacheKey(provider: string, kind: GeocodeKind, query: string): string {
  return `${provider}:${kind}:${query}`
}

/** The reverse query as it is keyed and sent: "<lat>,<lng>", rounded. */
export function reverseQueryKey(lat: number, lng: number): string {
  return `${roundForReverse(lat)},${roundForReverse(lng)}`
}

/* ------------------------------- the ttls --------------------------------- */

/** Place names do not move. Thirty days. */
export const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * An EMPTY answer keeps for a day, not thirty.
 *
 * "No matches" is a real answer and worth caching — a typo re-typed should not
 * cost a request. But it is also the answer a geocoder gives while it is having
 * a bad day, and it is the cheapest one to ask for again. Thirty days of "there
 * is no such place" following one bad afternoon is a worse trade than one day.
 */
export const EMPTY_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/* ----------------------------- the rate limit ----------------------------- */

/**
 * At most one request per second, with 100 ms of slack: the policy is a limit,
 * not a target, and a clock that rounds the wrong way is not a defence.
 */
const MIN_INTERVAL_MS = 1100

/**
 * How long a caller will wait for its turn before being told the geocoder is
 * busy. Four seconds is three people ahead of you; past that the person at the
 * keyboard has retyped anyway, and a queue that grows without a bound is how a
 * rate limiter becomes an outage of its own.
 */
const MAX_WAIT_MS = 4000

/** A provider that answered 429 or 403 is left alone for this long. */
const COOLDOWN_MS = 5 * 60 * 1000

/**
 * What the gate said, and the two refusals are NOT the same sentence.
 *
 * `busy` is ours — the queue in this process is longer than anybody will wait.
 * `cooldown` is theirs — the provider answered 429 or 403 and we are leaving it
 * alone. Collapsing them tells the owner "our queue is too long" for the five
 * minutes after a block, which is the opposite diagnosis and points at the
 * wrong fix.
 */
export type GateOutcome = 'go' | 'busy' | 'cooldown'

export interface RateGate {
  /** Whether the caller may make its request now, after any wait it did. */
  take(): Promise<GateOutcome>
  /** Stop calling for `ms`; the provider has said so. */
  block(ms: number): void
}

export interface RateGateOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  minIntervalMs?: number
  maxWaitMs?: number
}

/**
 * A token bucket of one token per `minIntervalMs`, with a cooldown.
 *
 * The reservation is SYNCHRONOUS and the wait comes after it: `releaseAt` is
 * moved before anything is awaited, so two callers arriving in the same tick
 * take two different slots. Reserving after the wait — the obvious shape —
 * lets every concurrent caller read the same `releaseAt`, sleep the same
 * length and fire together, which is a rate limiter that does nothing under
 * precisely the load it exists for.
 *
 * A caller whose turn is further away than `maxWaitMs` takes NO slot and is
 * told to give up, so the queue is bounded by time rather than by a count of
 * things that might be waiting.
 *
 * ⚠️ THE COOLDOWN IS CHECKED TWICE, BEFORE THE WAIT AND AFTER IT, and the
 * second check is the one that matters. A caller who reserved its slot and is
 * asleep has already passed the first; `block()` fires while it sleeps, and
 * without the re-check it wakes up and calls the provider that has just told us
 * to stop — as do the two or three behind it, so one 429 is answered with three
 * more requests over the following three seconds. That is precisely the "retry
 * into a refusal" this file says it does not do. Checking only before the sleep
 * tests both halves of the gate and never their interaction.
 */
export function createRateGate(options: RateGateOptions = {}): RateGate {
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const minInterval = options.minIntervalMs ?? MIN_INTERVAL_MS
  const maxWait = options.maxWaitMs ?? MAX_WAIT_MS

  let releaseAt = 0
  let blockedUntil = 0

  return {
    async take(): Promise<GateOutcome> {
      const t = now()
      if (t < blockedUntil) return 'cooldown'
      const start = Math.max(t, releaseAt)
      const wait = start - t
      if (wait > maxWait) return 'busy'
      releaseAt = start + minInterval
      if (wait > 0) await sleep(wait)
      // The provider may have refused somebody else while this caller slept.
      if (now() < blockedUntil) return 'cooldown'
      return 'go'
    },
    block(ms: number) {
      blockedUntil = Math.max(blockedUntil, now() + ms)
    }
  }
}

/* ---------------------------- the Nominatim client ------------------------ */

const NOMINATIM = 'https://nominatim.openstreetmap.org'

/**
 * WHERE THE GEOCODER IS, AND THE ONE LEVER OVER IT.
 *
 * Unset — which is every real instance — means Nominatim, so nothing about the
 * owner's deployment changes and there is nothing to configure. The variable
 * exists for two situations that both arrive at a bad moment:
 *
 *  - A TEST HARNESS MUST NOT SEND LIVE TRAFFIC. `scripts/api-smoke.sh` exercises
 *    this feature with queries salted per run, precisely so the cache cannot
 *    spare the request — and that suite runs twice per CI run, on every push
 *    and every pull request, from shared runner addresses, under the same
 *    `zaeme/1.0` User-Agent prefix production sends. A block earned by CI is a
 *    block served to the owner's instance. So CI points this at
 *    `scripts/geocoder-stub.mjs` and sends OpenStreetMap nothing.
 *  - AN INSTANCE MAY NEED SEARCH OFF NOW. Point it at an address that refuses
 *    connections (`http://127.0.0.1:1`) and every search degrades immediately
 *    to "search is unavailable, type the name" — no timeout, no outbound
 *    request. That is the lever you want to already exist on the day somebody
 *    is told to stop calling, and inventing it under pressure is how it gets
 *    invented badly.
 *
 * Read per call rather than at import: a module-level constant cannot be
 * changed by a test without reloading the module, and the whole point is that
 * this is reachable from outside the process.
 */
export function geocoderBase(): string {
  const configured = (process.env.ZAEME_GEOCODER_URL ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(configured) ? configured : NOMINATIM
}

/** How long a person at a keyboard waits for a geocoder before giving up. */
const TIMEOUT_MS = 4000

/** Enough to choose from; more is a list nobody reads. */
const RESULT_LIMIT = 8

/**
 * Who is calling, which the policy requires and which is also how whoever runs
 * this instance gets told they are doing something wrong rather than blocked.
 *
 * `BASE_URL` is the contact address: it is a page with the owner behind it. An
 * instance with no origin configured falls back to the project's own URL, which
 * still identifies the software — a stock `node-fetch` User-Agent is the one
 * thing the policy names as unacceptable.
 */
export function userAgent(): string {
  return `zaeme/1.0 (+${publicOrigin() || 'https://github.com/Bermos/zaeme'})`
}

/** The provider said no: 429 (too many) or 403 (blocked). Stop asking. */
export class GeocoderRefused extends Error {
  constructor(readonly status: number) {
    super(`the geocoder answered ${status}`)
    this.name = 'GeocoderRefused'
  }
}

export interface GeocoderFetchOptions {
  query: Record<string, string | number>
  headers: Record<string, string>
  timeout: number
  retry: number | false
}

export type GeocoderFetch = (url: string, options: GeocoderFetchOptions) => Promise<unknown>

/** The status a failed `$fetch` carries, wherever ofetch happens to put it. */
function statusOf(err: unknown): number | null {
  const e = err as { status?: number, statusCode?: number, response?: { status?: number } }
  return e?.status ?? e?.statusCode ?? e?.response?.status ?? null
}

/**
 * One Nominatim result, as `PlaceSuggestion` — or null if it cannot be used.
 *
 * NULL RATHER THAN A THROW, and rather than a half-filled suggestion: a result
 * with no usable coordinates is exactly the row that must not become a place,
 * and one bad entry in a list of eight must not lose the other seven.
 * `normaliseCoordinates` is #30's own rule, reused deliberately — what a search
 * offers has to land in the same column by the same arithmetic, including the
 * rounding from Nominatim's seven decimals to the column's six.
 */
export function mapNominatimResult(raw: unknown): PlaceSuggestion | null {
  const r = raw as {
    lat?: unknown
    lon?: unknown
    name?: unknown
    display_name?: unknown
    osm_type?: unknown
    osm_id?: unknown
    type?: unknown
    category?: unknown
    address?: { country_code?: unknown }
  }
  if (!r || typeof r !== 'object') return null

  let lat: number
  let lng: number
  try {
    const pair = normaliseCoordinates(r.lat as string, r.lon as string)
    if (pair.lat === null || pair.lng === null) return null
    lat = Number(pair.lat)
    lng = Number(pair.lng)
  } catch {
    // A missing, malformed or off-planet coordinate. There is nothing to
    // salvage and the other results are unaffected.
    return null
  }

  const displayName = typeof r.display_name === 'string' ? r.display_name : null
  // Nominatim's `name` is the feature's own name and is empty for an address
  // with no name of its own — a house number, most reverse lookups. The first
  // segment of `display_name` is then what a person would call the place.
  const named = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : null
  const name = named ?? displayName?.split(',')[0]?.trim() ?? null
  if (!name) return null

  const osmType = r.osm_type === 'node' || r.osm_type === 'way' || r.osm_type === 'relation' ? r.osm_type : null
  const osmId = osmType !== null && (typeof r.osm_id === 'string' || typeof r.osm_id === 'number')
    ? `${r.osm_id}`
    : null

  return {
    name,
    address: displayName,
    lat,
    lng,
    // Both or neither, the rule `events_place` keeps: an id whose type was not
    // one of the three identifies nothing.
    osmType: osmId === null ? null : osmType,
    osmId,
    category: typeof r.type === 'string' ? r.type : typeof r.category === 'string' ? r.category : null,
    // Only present with `addressdetails=1`, which `search` now asks for and
    // `reverse` gets by default. Two letters or nothing — a longer or shorter
    // value is not a country code and would only reach `Intl` to be refused.
    countryCode: typeof r.address?.country_code === 'string' && /^[A-Za-z]{2}$/.test(r.address.country_code)
      ? r.address.country_code.toLowerCase()
      : null
  }
}

/**
 * The Nominatim provider. `fetchImpl` is injectable for one reason: the
 * REQUEST — its URL, its parameters and above all its `User-Agent` — is the
 * half of the policy that can be proved without calling anybody.
 */
export function createNominatimProvider(fetchImpl?: GeocoderFetch): GeocoderProvider {
  const call = async (path: string, query: Record<string, string | number>): Promise<unknown> => {
    // The cast is Nuxt's typed-route inference, not a looseness: `$fetch`
    // resolves its overload against this app's own route keys, and handing it a
    // `string` url makes that inference recurse until the compiler gives up
    // ("excessive stack depth"). `GeocoderFetch` is the shape actually used.
    const doFetch = fetchImpl ?? ($fetch as unknown as GeocoderFetch)
    try {
      return await doFetch(`${geocoderBase()}${path}`, {
        query: { format: 'jsonv2', ...query },
        headers: { 'User-Agent': userAgent(), 'Accept': 'application/json' },
        timeout: TIMEOUT_MS,
        retry: false
      })
    } catch (err) {
      const status = statusOf(err)
      // 429 and 403 are the provider telling us to stop. Everything else — a
      // timeout, a DNS failure, a 500 at their end — is "could not ask", and
      // the difference matters: only the first one earns a cooldown.
      if (status === 429 || status === 403) throw new GeocoderRefused(status)
      throw err
    }
  }

  return {
    name: 'nominatim',
    attribution: '© OpenStreetMap contributors',
    async search(query: string) {
      // `addressdetails=1` for ONE field: `address.country_code`, which is how
      // a geocoded place offers the trip's zone (#31). Reverse answers it
      // without being asked.
      const raw = await call('/search', { q: query, limit: RESULT_LIMIT, addressdetails: 1 })
      return Array.isArray(raw) ? raw.map(mapNominatimResult).filter((s): s is PlaceSuggestion => s !== null) : []
    },
    async reverse(lat: number, lng: number) {
      const raw = await call('/reverse', { lat, lon: lng })
      // Reverse answers ONE object, not a list — and an object carrying an
      // `error` when there is nothing at that point (the middle of the sea),
      // which maps to null and therefore to an empty, successful answer.
      const one = mapNominatimResult(raw)
      return one ? [one] : []
    }
  }
}

/* ------------------------------- the store -------------------------------- */

/** The cache as the table. The only part of this module that touches Postgres. */
export function databaseCacheStore(): GeocodeCacheStore {
  return {
    async read(key: string) {
      const [row] = await useDb()
        .select({ results: geocodeCache.results, expiresAt: geocodeCache.expiresAt })
        .from(geocodeCache)
        .where(eq(geocodeCache.key, key))
        .limit(1)
      if (!row) return null
      return { results: row.results as PlaceSuggestion[], expiresAt: row.expiresAt }
    },
    async write(entry) {
      await useDb()
        .insert(geocodeCache)
        .values({
          key: entry.key,
          provider: entry.provider,
          kind: entry.kind,
          query: entry.query,
          results: entry.results,
          fetchedAt: new Date(),
          expiresAt: entry.expiresAt
        })
        // A fresher answer replaces the stale one it was fetched to replace.
        .onConflictDoUpdate({
          target: geocodeCache.key,
          set: { results: entry.results, fetchedAt: new Date(), expiresAt: entry.expiresAt }
        })
    },
    async sweep(now: Date) {
      await useDb().delete(geocodeCache).where(lt(geocodeCache.expiresAt, now))
    }
  }
}

/* ------------------------------- the policy ------------------------------- */

/**
 * The one production gate. Module-level on purpose: it is the instance's
 * promise about its outbound rate, so every caller in this process has to share
 * it. Tests build their own rather than reaching for this one.
 */
const rateGate = createRateGate()

const provider = createNominatimProvider()

export interface GeocodeDeps {
  provider?: GeocoderProvider
  store?: GeocodeCacheStore
  gate?: RateGate
  now?: () => Date
}

/**
 * WHY A FAILED SEARCH IS WORTH A LOG LINE.
 *
 * `reason` is the only place the difference between "OpenStreetMap is having a
 * bad afternoon" and "this instance has been blocked" exists, and no screen may
 * show it: every planner sees one sentence, "search is unavailable, type the
 * name", which is the right thing to say to somebody who wants to add a place
 * and useless to the person who has to fix it. Without this line the owner's
 * only signal that their instance is on a blocklist is a feature that stopped
 * working for everybody at once, with nothing anywhere saying why.
 *
 * The QUERY IS NOT LOGGED, deliberately: the same reasoning as the cache
 * table's — an instance-wide record of what its users are looking for is a
 * decision for the owner, not a field somebody adds while debugging.
 */
function reportUnavailable(reason: GeocodeUnavailable, kind: GeocodeKind, providerName: string): void {
  console.warn('[zaeme:geocode] unavailable', { reason, kind, provider: providerName })
}

/**
 * Cache, then gate, then provider — and write back only a real answer.
 *
 * The order is the whole design. A cached answer costs nothing and is checked
 * FIRST, which is why the rate limit is unreachable in normal use; the gate is
 * consulted only when something is actually about to leave the process; and a
 * failure is NEVER written to the cache, because caching "we could not ask"
 * turns a thirty-second outage into a thirty-day one.
 *
 * A STALE ANSWER BEATS NO ANSWER, but only when it has something in it. The
 * thirty-day ttl is an argument — place names do not move — and that argument
 * does not stop being true at midnight on the thirty-first day: if the geocoder
 * cannot be reached, an expired row with results in it is still the right
 * answer to give, and throwing it away to say "unavailable" is losing
 * information the instance already has. An expired EMPTY row is the opposite:
 * "no matches" is the answer a bad afternoon produces, it keeps for a day for
 * that reason, and re-serving it past its life would harden somebody else's
 * outage into our own answer. The sweep runs only after a SUCCESSFUL fetch, so
 * an outage never deletes the rows this rule leans on.
 */
/**
 * The zones a suggestion implies, attached on the way out rather than stored.
 *
 * Derived on every read, cache hit included, so the answer follows ICU rather
 * than whatever ICU said thirty days ago — and so a row cached before this
 * feature existed (no `countryCode`) simply offers nothing, which is the same
 * thing a place in the middle of the sea offers. Nothing here can fail: an
 * unknown country is an empty list, not an error, because a geocoder that
 * cannot name a zone must still be able to name a place.
 */
function withTimezones(results: PlaceSuggestion[]): PlaceSuggestion[] {
  return results.map(r => ({ ...r, timeZones: timezonesForCountry(r.countryCode) }))
}

async function answer(
  kind: GeocodeKind,
  query: string,
  fetchIt: (p: GeocoderProvider) => Promise<PlaceSuggestion[]>,
  deps: GeocodeDeps
): Promise<GeocodeAnswer> {
  const p = deps.provider ?? provider
  const store = deps.store ?? databaseCacheStore()
  const gate = deps.gate ?? rateGate
  const now = deps.now ?? (() => new Date())

  const base = { query, provider: p.name, attribution: p.attribution }
  const key = geocodeCacheKey(p.name, kind, query)

  const hit = await store.read(key).catch(() => null)
  if (hit && hit.expiresAt.getTime() > now().getTime()) {
    return { status: 'ok', reason: null, results: withTimezones(hit.results), cached: true, ...base }
  }
  /** An expired row worth falling back on: see the note above. */
  const stale = hit && hit.results.length > 0 ? hit.results : null

  const unavailable = (reason: GeocodeUnavailable): GeocodeAnswer => {
    if (stale) return { status: 'ok', reason: null, results: withTimezones(stale), cached: true, ...base }
    reportUnavailable(reason, kind, p.name)
    return { status: 'unavailable', reason, results: [], cached: false, ...base }
  }

  const gated = await gate.take()
  if (gated !== 'go') {
    // `cooldown` and `busy` are different sentences: the provider told us to
    // stop, or our own queue is too long. Mapping both to "busy" reports the
    // wrong one for the whole five minutes after a block.
    return unavailable(gated === 'cooldown' ? 'geocoder_rate_limited' : 'geocoder_busy')
  }

  let results: PlaceSuggestion[]
  try {
    results = await fetchIt(p)
  } catch (err) {
    if (err instanceof GeocoderRefused) {
      gate.block(COOLDOWN_MS)
      return unavailable('geocoder_rate_limited')
    }
    return unavailable('geocoder_unreachable')
  }

  // A miss is the one moment something here is already paying for a round trip,
  // so it is where the expired rows are swept. Neither the sweep nor the write
  // may cost the caller its answer: the search succeeded.
  const ttl = results.length === 0 ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS
  await store.sweep(now()).catch(() => {})
  await store.write({
    key,
    provider: p.name,
    kind,
    query,
    results,
    expiresAt: new Date(now().getTime() + ttl)
  }).catch(() => {})

  return { status: 'ok', reason: null, results: withTimezones(results), cached: false, ...base }
}

/**
 * "ponte 25 de abril" → the bridge.
 *
 * The two refusals are SEPARATE SENTENCES because they are opposite advice: one
 * asks for more and the other for less, and a shared message told whoever
 * pasted a paragraph into the box to type at least two characters.
 */
export async function searchPlaces(raw: string, deps: GeocodeDeps = {}): Promise<GeocodeAnswer> {
  const query = foldQuery(raw)
  if (query.length < MIN_QUERY_LENGTH) {
    throw createError({
      statusCode: 422,
      message: `Type at least ${MIN_QUERY_LENGTH} characters to search for a place`
    })
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw createError({
      statusCode: 422,
      message: `That is longer than a place name — search for at most ${MAX_QUERY_LENGTH} characters`
    })
  }
  return answer('search', query, p => p.search(query), deps)
}

/**
 * A dropped pin, named. The coordinates are put through #30's own rule first,
 * so a latitude that is not on the planet is refused here rather than sent to
 * somebody else's server to be refused there.
 */
export async function reverseGeocode(
  lat: number | string,
  lng: number | string,
  deps: GeocodeDeps = {}
): Promise<GeocodeAnswer> {
  const pair = normaliseCoordinates(lat, lng)
  if (pair.lat === null || pair.lng === null) {
    throw createError({ statusCode: 422, message: 'A pin needs both a latitude and a longitude' })
  }
  const at = { lat: roundForReverse(Number(pair.lat)), lng: roundForReverse(Number(pair.lng)) }
  return answer('reverse', reverseQueryKey(at.lat, at.lng), p => p.reverse(at.lat, at.lng), deps)
}

/* ------------------------------- the gates -------------------------------- */

/**
 * WHO MAY SEARCH: the planners who may add a place, and nobody else.
 *
 * #32 as written offers this route to the invite capability URL as well, and
 * that is the one thing here decided against the issue. Two reasons, the second
 * of which is the serious one:
 *
 *  - a guest cannot create a place (#30 shipped that way and the owner has not
 *    widened it), so a search result is something a guest could look at and do
 *    nothing with;
 *  - the invite link is a CAPABILITY URL THAT GETS FORWARDED into group chats.
 *    Putting a third-party proxy behind it hands anyone holding a forwarded
 *    link the ability to drive queries at Nominatim under this instance's
 *    identifying `User-Agent` — which is how the instance gets rate-limited or
 *    blocked, and the audience for that ability would be unbounded.
 *
 * Widening it later is a new handler under `server/api/invites/**` that
 * resolves the token and calls `searchPlaces` — which takes no identity,
 * precisely so that day is a small one.
 *
 * The role set is `addPlaceAsPlanner`'s, not `loadGeographyAsPlanner`'s: this
 * exists to fill in a form only those two roles can submit, and the narrow side
 * is the one that can be widened later without taking anything back.
 */
export const GEOCODE_ROLES = ['owner', 'co_planner'] as const

export async function searchPlacesAsPlanner(userId: string, slug: string, query: string): Promise<GeocodeAnswer> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: [...GEOCODE_ROLES] })
  return searchPlaces(query)
}

export async function reverseGeocodeAsPlanner(
  userId: string,
  slug: string,
  lat: number | string,
  lng: number | string
): Promise<GeocodeAnswer> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: [...GEOCODE_ROLES] })
  return reverseGeocode(lat, lng)
}
