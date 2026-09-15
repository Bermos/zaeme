import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CACHE_TTL_MS,
  EMPTY_CACHE_TTL_MS,
  GeocoderRefused,
  createNominatimProvider,
  createRateGate,
  geocodeCacheKey,
  mapNominatimResult,
  normaliseQuery,
  reverseGeocode,
  reverseQueryKey,
  searchPlaces,
  userAgent,
  type CachedGeocode,
  foldQuery,
  geocoderBase,
  type GateOutcome,
  type GeocodeAnswer,
  type GeocodeCacheStore,
  type GeocoderProvider,
  type PlaceSuggestion,
  type RateGate
} from '../server/domain/geocode'
import { normaliseOsmRef } from '../server/domain/places'

/**
 * Searching for a place instead of typing its name (#32).
 *
 * A GEOCODER IS SOMEBODY ELSE'S SERVER, so the interesting tests here are the
 * ones that do not call it: the normalisation, the cache policy, the rate
 * limiter and all three ways this degrades. Every one of those is a decision
 * this repository made, and every one of them is wrong in a way no green
 * pipeline would otherwise show — a limiter that lets a burst through, a cache
 * that stores a failure for thirty days, an outage that renders as "no matches".
 *
 * Nothing in this file reaches the network, and that is deliberate rather than
 * convenient: a test whose green depends on Nominatim being up is a test that
 * reddens the branch of whoever pushes on a bad afternoon. The provider is
 * exercised through an injected `fetch`, which proves the REQUEST — its
 * parameters and above all its `User-Agent`, which the usage policy requires —
 * and the mapping is exercised over a recorded payload shape. The one
 * deliberate real call this change makes is in `scripts/api-smoke.sh`, against
 * a running server, and it is written so that a geocoder which cannot be
 * reached from CI proves the degrade path instead of failing the build.
 */

/* ------------------------------ the fixtures ------------------------------ */

/** A memory store, so the cache POLICY can be proved without a Postgres. */
function memoryStore() {
  const rows = new Map<string, CachedGeocode & { kind: string, query: string, provider: string }>()
  const store: GeocodeCacheStore = {
    async read(key) {
      return rows.get(key) ?? null
    },
    async write(entry) {
      rows.set(entry.key, {
        results: entry.results,
        expiresAt: entry.expiresAt,
        kind: entry.kind,
        query: entry.query,
        provider: entry.provider
      })
    },
    async sweep(now) {
      for (const [key, row] of rows) if (row.expiresAt.getTime() < now.getTime()) rows.delete(key)
    }
  }
  return { store, rows }
}

/** A provider that answers whatever the test tells it, and counts the asking. */
function stubProvider(answer: () => Promise<PlaceSuggestion[]>) {
  let calls = 0
  const provider: GeocoderProvider = {
    name: 'nominatim',
    attribution: '© OpenStreetMap contributors',
    async search() {
      calls++
      return answer()
    },
    async reverse() {
      calls++
      return answer()
    }
  }
  return { provider, calls: () => calls }
}

/** A gate that always allows, so a cache test is not also a limiter test. */
const openGate: RateGate = {
  async take(): Promise<GateOutcome> {
    return 'go'
  },
  block() {}
}

/** A gate refusing for the two different reasons it can refuse for. */
function shutGate(outcome: 'busy' | 'cooldown'): RateGate {
  return {
    async take(): Promise<GateOutcome> {
      return outcome
    },
    block() {}
  }
}

const bridge: PlaceSuggestion = {
  name: 'Ponte 25 de Abril',
  address: 'Ponte 25 de Abril, Lisboa, Portugal',
  lat: 38.689444,
  lng: -9.177222,
  osmType: 'way',
  osmId: '4306103',
  category: 'bridge'
}

const BASE_URL = process.env.BASE_URL
afterEach(() => {
  if (BASE_URL === undefined) delete process.env.BASE_URL
  else process.env.BASE_URL = BASE_URL
})

/* ----------------------------- normalisation ------------------------------ */

describe('one question is one cache key', () => {
  it('folds the ways of typing the same place name together', () => {
    // Case, padding and repeated spaces are three ways to type one question.
    // Keyed on the raw text they are three rows and three requests.
    expect(normaliseQuery('  Ponte   25 DE Abril ')).toBe('ponte 25 de abril')
    expect(normaliseQuery('ponte 25 de abril')).toBe('ponte 25 de abril')
    expect(normaliseQuery('PONTE 25 DE ABRIL')).toBe('ponte 25 de abril')
  })

  it('folds a decomposed accent onto a composed one', () => {
    // A browser can send "Zurich with an umlaut" as `u` + U+0308 while a keyboard
    // sends U+00FC.
    // The same word, two byte strings — and therefore, without NFC, two
    // separate requests for one answer.
    // Written as escapes on purpose: an editor that normalises this file would
    // otherwise quietly turn the two sides into the same bytes and the test
    // into a tautology.
    const decomposed = 'Zu\u0308rich'
    const composed = 'Z\u00fcrich'
    expect(decomposed).not.toBe(composed)
    expect(normaliseQuery(decomposed)).toBe(normaliseQuery(composed))
    expect(normaliseQuery(decomposed)).toBe('z\u00fcrich')
  })

  it('still tells two different places apart', () => {
    // The check the three above cannot make: a normaliser that returned a
    // constant would satisfy every one of them, and would serve Lisbon's
    // bridge for a search for Zug.
    expect(normaliseQuery('zug hb')).not.toBe(normaliseQuery('zurich hb'))
    expect(normaliseQuery('ponte 25 de abril')).not.toBe(normaliseQuery('ponte 24 de abril'))
  })

  it('refuses a query too short or too long to be a place name', () => {
    expect(normaliseQuery('z')).toBeNull()
    expect(normaliseQuery('   ')).toBeNull()
    expect(normaliseQuery('')).toBeNull()
    expect(normaliseQuery('zu')).toBe('zu')
    expect(normaliseQuery('x'.repeat(161))).toBeNull()
    expect(normaliseQuery('x'.repeat(160))).toBe('x'.repeat(160))
  })

  it('keeps a forward answer from ever being served for a reverse one', () => {
    // Same text, different question. Without `kind` in the key, reverse
    // geocoding "46.1,8.2" could be answered by a forward search for the same
    // string, which is a different operation with a different shape.
    expect(geocodeCacheKey('nominatim', 'search', '46.1,8.2'))
      .not.toBe(geocodeCacheKey('nominatim', 'reverse', '46.1,8.2'))
    // …and a provider swap must not serve the old provider's rows.
    expect(geocodeCacheKey('photon', 'search', 'zug hb'))
      .not.toBe(geocodeCacheKey('nominatim', 'search', 'zug hb'))
  })

  it('keys a dropped pin at about a metre, not at the column\'s precision', () => {
    // Two people pointing at the same door differ in the sixth decimal; keyed
    // there, every pin is its own row and the cache never hits.
    expect(reverseQueryKey(46.0045123, 8.9510501)).toBe(reverseQueryKey(46.00451, 8.95105))
    // …and a metre is still a metre: a point 100 m away is a different key.
    expect(reverseQueryKey(46.0045, 8.95105)).not.toBe(reverseQueryKey(46.00451, 8.95105))
  })
})

/* ------------------------------- the limiter ------------------------------ */

/**
 * A VIRTUAL CLOCK WHERE SLEEPS OVERLAP, which is the only kind that can tell
 * this limiter from a broken one.
 *
 * The obvious fake — `sleep: async ms => { t += ms }` — advances the shared
 * clock the instant it is called, so three concurrent callers are serialised
 * into three sequential ones and the wrong implementation (read the clock,
 * sleep, and only then reserve the slot) produces exactly the same numbers as
 * the right one. Here a sleep is a pending wake-up, time moves once when the
 * earliest of them is released, and callers genuinely wait side by side.
 */
function fakeClock() {
  let t = 1000
  const pending: Array<{ at: number, wake: () => void }> = []
  const sleep = (ms: number) => new Promise<void>((wake) => {
    pending.push({ at: t + ms, wake })
  })
  /** Run time forward until nothing is waiting. */
  const drain = async () => {
    // Let everything that did NOT have to wait resolve at the current time
    // first — otherwise the caller who was let straight through records the
    // clock as it stands after the first wake-up, and the one moment this
    // test is about (a caller going through with no wait at all) is lost.
    await new Promise(r => setTimeout(r, 0))
    // A bounded loop: a limiter that re-slept for ever would hang the suite.
    for (let i = 0; i < 100 && pending.length; i++) {
      pending.sort((a, b) => a.at - b.at)
      const next = pending.shift()!
      t = Math.max(t, next.at)
      next.wake()
      await new Promise(r => setTimeout(r, 0))
    }
  }
  return { now: () => t, sleep, drain, at: () => t }
}

describe('at most one request a second, whatever the browser does', () => {
  /** Three planners typing at the same moment, and when each was let through. */
  async function burst(gate: RateGate, clock: ReturnType<typeof fakeClock>, n = 3) {
    const lets: Array<{ ok: GateOutcome, at: number }> = []
    const takes = Array.from({ length: n }, async () => {
      const ok = await gate.take()
      lets.push({ ok, at: clock.at() })
    })
    await clock.drain()
    await Promise.all(takes)
    return lets
  }

  it('spaces sequential callers a second apart', async () => {
    const clock = fakeClock()
    const gate = createRateGate(clock)
    expect(await gate.take()).toBe('go')
    const first = clock.at()
    const second = gate.take()
    await clock.drain()
    expect(await second).toBe('go')
    expect(clock.at() - first).toBe(1100)
  })

  it('spaces CONCURRENT callers too, which is the case it exists for', async () => {
    // A gate that reads the clock, sleeps and only THEN reserves its slot lets
    // all three read the same release time, sleep the same length and fire
    // together — a rate limiter that does nothing under exactly the load it is
    // for. Under that implementation all three of these are let through at
    // 1000; the reservation being synchronous is what spreads them.
    const clock = fakeClock()
    const lets = await burst(createRateGate(clock), clock)
    expect(lets.map(l => l.ok)).toEqual(['go', 'go', 'go'])
    expect(lets.map(l => l.at)).toEqual([1000, 2100, 3200])
  })

  it('tells a caller to give up rather than queueing it for ever', async () => {
    // The third of three at once would wait 2200 ms, past the bound: refused,
    // and — the part that matters — it takes NO slot, so a turned-away caller
    // cannot push the queue further out for everybody behind it.
    const clock = fakeClock()
    const gate = createRateGate({ ...clock, maxWaitMs: 2000 })
    const lets = await burst(gate, clock)
    expect(lets.map(l => l.ok).sort()).toEqual(['busy', 'go', 'go'])
    // …and the refused caller left the queue where it found it. The second
    // took the slot at 2100 and reserved to 3200, so a fourth arriving now is
    // let through THERE — a gate that reserved for the caller it turned away
    // would make it wait to 4300 instead.
    const fourth = gate.take()
    await clock.drain()
    expect(await fourth).toBe('go')
    expect(clock.at()).toBe(3200)
  })

  it('reaches a caller who was already asleep when the block landed', async () => {
    // THE HALF THAT WAS MISSING. `block()` fires while two callers are mid-sleep
    // — they have already passed the check at the top of `take()` — so a gate
    // that tests the cooldown only before waiting lets them wake up and call the
    // provider that has just told us to stop. Three refusals for one 429.
    const clock = fakeClock()
    const gate = createRateGate(clock)
    const outcomes: GateOutcome[] = []
    const takes = [0, 1, 2].map(async () => {
      outcomes.push(await gate.take())
    })
    // The first is through immediately; the other two are asleep. Block now.
    await new Promise(r => setTimeout(r, 0))
    gate.block(300000)
    await clock.drain()
    await Promise.all(takes)
    expect(outcomes).toEqual(['go', 'cooldown', 'cooldown'])
  })

  it('stops entirely when the provider has said to stop', async () => {
    let t = 1000
    const gate = createRateGate({ now: () => t, sleep: async () => {} })
    gate.block(5000)
    // 'cooldown', not 'busy': the provider said stop, our queue is empty.
    expect(await gate.take()).toBe('cooldown')
    expect(await gate.take()).toBe('cooldown')
    // …and starts again once the cooldown has passed, rather than latching off.
    t += 5001
    expect(await gate.take()).toBe('go')
  })
})

/* --------------------------- the cache and degrade ------------------------ */

describe('a search asks once and remembers the answer', () => {
  it('answers the second identical search out of the cache', async () => {
    // The acceptance criterion, and the reason the rate limit is unreachable in
    // normal use.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])

    const first = await searchPlaces('Ponte 25 de Abril', { provider, store, gate: openGate })
    expect(first).toMatchObject({ status: 'ok', cached: false, results: [bridge] })

    // Typed differently on purpose: the cache is keyed on the NORMALISED query,
    // so this is the same question and must not cost a second request.
    const second = await searchPlaces('  ponte 25 DE abril ', { provider, store, gate: openGate })
    expect(second).toMatchObject({ status: 'ok', cached: true, results: [bridge] })
    expect(calls()).toBe(1)
  })

  it('asks again once the answer has expired', async () => {
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])
    let t = new Date('2027-06-01T10:00:00Z')

    await searchPlaces('zug hb', { provider, store, gate: openGate, now: () => t })
    t = new Date(t.getTime() + CACHE_TTL_MS + 1)
    const after = await searchPlaces('zug hb', { provider, store, gate: openGate, now: () => t })
    expect(after.cached).toBe(false)
    expect(calls()).toBe(2)
  })

  it('keeps "no matches" for a day and a real answer for thirty', async () => {
    // Two ttls, and the difference is a judgement: "no such place" is also what
    // a geocoder having a bad afternoon says, and it is the cheapest answer to
    // ask for again. One shared constant satisfies neither half of that.
    const { store, rows } = memoryStore()
    const t = new Date('2027-06-01T10:00:00Z')
    const full = stubProvider(async () => [bridge])
    const empty = stubProvider(async () => [])

    await searchPlaces('zug hb', { provider: full.provider, store, gate: openGate, now: () => t })
    await searchPlaces('qqqqzz', { provider: empty.provider, store, gate: openGate, now: () => t })

    expect(rows.get('nominatim:search:zug hb')!.expiresAt.getTime()).toBe(t.getTime() + CACHE_TTL_MS)
    expect(rows.get('nominatim:search:qqqqzz')!.expiresAt.getTime()).toBe(t.getTime() + EMPTY_CACHE_TTL_MS)
    expect(EMPTY_CACHE_TTL_MS).toBeLessThan(CACHE_TTL_MS)
  })

  it('remembers "no matches", because a re-typed typo is still a request', async () => {
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [])
    const first = await searchPlaces('qqqqzz', { provider, store, gate: openGate })
    expect(first).toMatchObject({ status: 'ok', results: [], cached: false })
    const second = await searchPlaces('qqqqzz', { provider, store, gate: openGate })
    expect(second).toMatchObject({ status: 'ok', results: [], cached: true })
    expect(calls()).toBe(1)
  })

  it('sweeps expired rows when it is already paying for a round trip', async () => {
    const { store, rows } = memoryStore()
    const { provider } = stubProvider(async () => [bridge])
    let t = new Date('2027-06-01T10:00:00Z')

    await searchPlaces('zug hb', { provider, store, gate: openGate, now: () => t })
    expect(rows.size).toBe(1)
    t = new Date(t.getTime() + CACHE_TTL_MS + 1)
    // A MISS on a different key: the stale row goes with it rather than sitting
    // in the table for ever, which is the only thing keeping this bounded.
    await searchPlaces('lakeside', { provider, store, gate: openGate, now: () => t })
    expect([...rows.keys()]).toEqual(['nominatim:search:lakeside'])
  })
})

describe('a geocoder that cannot be reached is not a failed page', () => {
  it('says unavailable when the provider throws, and caches nothing', async () => {
    // THE FAILURE THAT MUST NOT BE CACHED. Storing "we could not ask" for
    // thirty days turns a thirty-second outage into a month-long one.
    const { store, rows } = memoryStore()
    const { provider } = stubProvider(async () => {
      throw new Error('ETIMEDOUT')
    })
    const answer = await searchPlaces('zug hb', { provider, store, gate: openGate })
    expect(answer).toMatchObject({ status: 'unavailable', reason: 'geocoder_unreachable', results: [], cached: false })
    expect(rows.size).toBe(0)
  })

  it('tells "could not ask" apart from "there is no such place"', async () => {
    // The two states the UI must not render the same way. This is the
    // assertion that fails if `status` is ever dropped for a bare array.
    const { store } = memoryStore()
    const down = stubProvider(async () => {
      throw new Error('ECONNREFUSED')
    })
    const nothing = stubProvider(async () => [])
    const a = await searchPlaces('zug hb', { provider: down.provider, store, gate: openGate })
    const b = await searchPlaces('qqqqzz', { provider: nothing.provider, store, gate: openGate })
    expect(a.results).toEqual(b.results)
    expect(a.status).not.toBe(b.status)
    expect(a.status).toBe('unavailable')
    expect(b.status).toBe('ok')
  })

  it('stops calling a provider that answered 429, and says which failure it was', async () => {
    // Retrying into a refusal is how a rate limit becomes a ban. The cooldown
    // is on the GATE, so the second search never reaches the provider at all.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => {
      throw new GeocoderRefused(429)
    })
    const gate = createRateGate({ now: () => 1000, sleep: async () => {} })

    const first = await searchPlaces('zug hb', { provider, store, gate })
    expect(first).toMatchObject({ status: 'unavailable', reason: 'geocoder_rate_limited' })
    const second = await searchPlaces('lakeside', { provider, store, gate })
    expect(second.status).toBe('unavailable')
    expect(calls()).toBe(1)
  })

  it('says busy — a third thing again — when the queue is too long', async () => {
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])
    const answer = await searchPlaces('zug hb', { provider, store, gate: shutGate('busy') })
    expect(answer).toMatchObject({ status: 'unavailable', reason: 'geocoder_busy', results: [] })
    expect(calls()).toBe(0)
  })

  it('serves a cached answer even while the geocoder is refusing', async () => {
    // The cache is checked BEFORE the gate, which is what makes an outage
    // invisible for everything already looked up.
    const { store } = memoryStore()
    const up = stubProvider(async () => [bridge])
    await searchPlaces('zug hb', { provider: up.provider, store, gate: openGate })

    const down = stubProvider(async () => {
      throw new Error('ETIMEDOUT')
    })
    const answer = await searchPlaces('zug hb', { provider: down.provider, store, gate: shutGate('busy') })
    expect(answer).toMatchObject({ status: 'ok', cached: true, results: [bridge] })
  })

  it('answers one 429 with ONE request, not with the three behind it', async () => {
    // The end-to-end version of the gate test above, through `searchPlaces`:
    // three planners typing at the same moment against a provider that is
    // refusing. Without the re-check after the sleep this is four calls to a
    // service that has just said stop — over three seconds, which is exactly
    // how a rate limit becomes a ban.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => {
      throw new GeocoderRefused(429)
    })
    const clock = fakeClock()
    const gate = createRateGate(clock)

    const answers: GeocodeAnswer[] = []
    const searches = ['zug hb', 'lakeside', 'ana flat'].map(async (q) => {
      answers.push(await searchPlaces(q, { provider, store, gate }))
    })
    await clock.drain()
    await Promise.all(searches)

    expect(calls()).toBe(1)
    // …and all three say the same true thing about why.
    expect(answers.map(a => a.reason)).toEqual([
      'geocoder_rate_limited', 'geocoder_rate_limited', 'geocoder_rate_limited'
    ])
  })

  it('keeps saying "rate limited" for the whole cooldown, not "busy"', async () => {
    // The five minutes after a 429 are refused by the GATE, not by the fetch,
    // and mapping that to `geocoder_busy` reports our own queue — the opposite
    // diagnosis, for 299 of the 300 seconds. Asserting only `status` here looks
    // like coverage of exactly this and is not.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => {
      throw new GeocoderRefused(403)
    })
    let t = 1000
    const gate = createRateGate({ now: () => t, sleep: async () => {} })

    const first = await searchPlaces('zug hb', { provider, store, gate })
    expect(first.reason).toBe('geocoder_rate_limited')
    t += 60_000
    const later = await searchPlaces('lakeside', { provider, store, gate })
    expect(later).toMatchObject({ status: 'unavailable', reason: 'geocoder_rate_limited' })
    expect(calls()).toBe(1)
  })

  it('serves a STALE answer rather than nothing when the geocoder is down', async () => {
    // The thirty-day ttl is the argument that place names do not move, and that
    // argument does not stop being true at midnight on the thirty-first day. An
    // expired row with results in it is still the right answer; throwing it away
    // to say "unavailable" loses something the instance already has.
    const { store } = memoryStore()
    let t = new Date('2027-06-01T10:00:00Z')
    const up = stubProvider(async () => [bridge])
    await searchPlaces('zug hb', { provider: up.provider, store, gate: openGate, now: () => t })

    t = new Date(t.getTime() + CACHE_TTL_MS + 1)
    const down = stubProvider(async () => {
      throw new Error('ETIMEDOUT')
    })
    const answer = await searchPlaces('zug hb', { provider: down.provider, store, gate: openGate, now: () => t })
    expect(answer).toMatchObject({ status: 'ok', cached: true, results: [bridge] })
    // It tried first: a stale answer is the fallback, never the plan.
    expect(down.calls()).toBe(1)
  })

  it('…and does NOT re-serve a stale "no matches"', async () => {
    // The one-day ttl exists because an empty answer is also what a bad
    // afternoon produces. Re-serving it past its life hardens somebody else's
    // outage into our own answer, which is the opposite of the rule above.
    const { store } = memoryStore()
    let t = new Date('2027-06-01T10:00:00Z')
    const empty = stubProvider(async () => [])
    await searchPlaces('qqqqzz', { provider: empty.provider, store, gate: openGate, now: () => t })

    t = new Date(t.getTime() + EMPTY_CACHE_TTL_MS + 1)
    const down = stubProvider(async () => {
      throw new Error('ETIMEDOUT')
    })
    const answer = await searchPlaces('qqqqzz', { provider: down.provider, store, gate: openGate, now: () => t })
    expect(answer).toMatchObject({ status: 'unavailable', reason: 'geocoder_unreachable', results: [] })
  })

  it('falls back on a stale answer when the gate refuses too', async () => {
    // Not only on a failed fetch: during a cooldown nothing may leave the
    // process at all, and a row that was good yesterday is still the best thing
    // this instance can say.
    const { store } = memoryStore()
    let t = new Date('2027-06-01T10:00:00Z')
    const up = stubProvider(async () => [bridge])
    await searchPlaces('zug hb', { provider: up.provider, store, gate: openGate, now: () => t })

    t = new Date(t.getTime() + CACHE_TTL_MS + 1)
    const answer = await searchPlaces('zug hb', {
      provider: up.provider, store, gate: shutGate('cooldown'), now: () => t
    })
    expect(answer).toMatchObject({ status: 'ok', cached: true, results: [bridge] })
    expect(up.calls()).toBe(1)
  })

  it('tells "type more" from "that is not a place name"', async () => {
    // Opposite advice, and one shared message told whoever pasted a paragraph
    // into the box to type at least two characters.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])
    await expect(searchPlaces('z', { provider, store, gate: openGate }))
      .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/at least 2 characters/) })
    await expect(searchPlaces('x'.repeat(161), { provider, store, gate: openGate }))
      .rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/at most 160 characters/) })
    expect(calls()).toBe(0)
  })

  it('refuses a query too short to be one, rather than answering it empty', async () => {
    // "Type more" and "there is no such place" are different sentences, and a
    // 422 is the domain having understood the request.
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])
    await expect(searchPlaces('z', { provider, store, gate: openGate }))
      .rejects.toMatchObject({ statusCode: 422 })
    expect(calls()).toBe(0)
  })
})

/* ------------------------- reverse, and the request ----------------------- */

describe('dropping a pin names a place', () => {
  it('asks about the rounded point it keyed, not the one it was handed', async () => {
    // Otherwise the cached answer is an answer to a question that was never
    // asked: keyed at five decimals, sent at seventeen.
    const asked: Array<[number, number]> = []
    const provider: GeocoderProvider = {
      name: 'nominatim',
      attribution: '© OpenStreetMap contributors',
      async search() {
        return []
      },
      async reverse(lat, lng) {
        asked.push([lat, lng])
        return [bridge]
      }
    }
    const { store } = memoryStore()
    await reverseGeocode('38.6894441234', '-9.1772221234', { provider, store, gate: openGate })
    expect(asked).toEqual([[38.68944, -9.17722]])
  })

  it('refuses half a pin, and a latitude that is not on the planet', async () => {
    const { store } = memoryStore()
    const { provider, calls } = stubProvider(async () => [bridge])
    await expect(reverseGeocode('46.1', '', { provider, store, gate: openGate }))
      .rejects.toMatchObject({ statusCode: 422 })
    await expect(reverseGeocode('91', '0', { provider, store, gate: openGate }))
      .rejects.toMatchObject({ statusCode: 422 })
    expect(calls()).toBe(0)
  })
})

describe('the outbound request identifies this instance', () => {
  it('names zäme and the instance BASE_URL in the User-Agent', () => {
    // Nominatim's policy names a stock HTTP-library User-Agent as the one thing
    // it will not accept, and blocks instances that send one.
    process.env.BASE_URL = 'https://zaeme.example'
    expect(userAgent()).toBe('zaeme/1.0 (+https://zaeme.example)')
    // …and an instance with no origin configured still identifies the software
    // rather than falling back to whatever ofetch would send.
    delete process.env.BASE_URL
    expect(userAgent()).toMatch(/^zaeme\/1\.0 \(\+https:\/\/.+\)$/)
  })

  it('sends it, with the parameters the search needs', async () => {
    process.env.BASE_URL = 'https://zaeme.example'
    const seen: Array<{ url: string, options: Record<string, unknown> }> = []
    const provider = createNominatimProvider(async (url, options) => {
      seen.push({ url, options: options as unknown as Record<string, unknown> })
      return []
    })
    await provider.search('ponte 25 de abril')

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe('https://nominatim.openstreetmap.org/search')
    const options = seen[0]!.options as {
      query: Record<string, unknown>
      headers: Record<string, string>
      timeout: number
    }
    expect(options.headers['User-Agent']).toBe('zaeme/1.0 (+https://zaeme.example)')
    expect(options.query).toMatchObject({ format: 'jsonv2', q: 'ponte 25 de abril' })
    // A request with no timeout is a search box that hangs for ever.
    expect(options.timeout).toBeGreaterThan(0)
  })

  it('reverses against /reverse with lat and lon', async () => {
    const seen: string[] = []
    const provider = createNominatimProvider(async (url, options) => {
      seen.push(`${url}?${new URLSearchParams(options.query as Record<string, string>)}`)
      return {}
    })
    await provider.reverse(38.68944, -9.17722)
    expect(seen[0]).toContain('https://nominatim.openstreetmap.org/reverse')
    expect(seen[0]).toContain('lat=38.68944')
    expect(seen[0]).toContain('lon=-9.17722')
  })

  it('turns a 429 or a 403 into the refusal that earns a cooldown', async () => {
    // …and NOTHING ELSE. A timeout and a 500 are "could not ask", which must
    // not stop the instance calling for five minutes.
    for (const status of [429, 403]) {
      const provider = createNominatimProvider(async () => {
        throw Object.assign(new Error('nope'), { status })
      })
      await expect(provider.search('zug hb')).rejects.toBeInstanceOf(GeocoderRefused)
    }
    for (const status of [500, 502]) {
      const provider = createNominatimProvider(async () => {
        throw Object.assign(new Error('nope'), { status })
      })
      await expect(provider.search('zug hb')).rejects.not.toBeInstanceOf(GeocoderRefused)
    }
    const timedOut = createNominatimProvider(async () => {
      throw new Error('ETIMEDOUT')
    })
    await expect(timedOut.search('zug hb')).rejects.not.toBeInstanceOf(GeocoderRefused)
  })
})

describe('the geocoder has one lever over it', () => {
  const SAVED = process.env.ZAEME_GEOCODER_URL
  afterEach(() => {
    if (SAVED === undefined) delete process.env.ZAEME_GEOCODER_URL
    else process.env.ZAEME_GEOCODER_URL = SAVED
  })

  it('is Nominatim when nothing is configured, which is every real instance', () => {
    delete process.env.ZAEME_GEOCODER_URL
    expect(geocoderBase()).toBe('https://nominatim.openstreetmap.org')
    // …and a value that is not an http(s) URL is ignored rather than turned
    // into a request to nowhere: a typo must not silently break search.
    process.env.ZAEME_GEOCODER_URL = 'nominatim.openstreetmap.org'
    expect(geocoderBase()).toBe('https://nominatim.openstreetmap.org')
  })

  it('points somewhere else when it is, and the provider goes there', async () => {
    // The whole point: CI aims this at a stub so a test suite never sends live
    // traffic under this software's User-Agent, and an instance that has been
    // told to stop calling aims it at an address that refuses connections.
    process.env.ZAEME_GEOCODER_URL = 'http://127.0.0.1:3333/'
    expect(geocoderBase()).toBe('http://127.0.0.1:3333')

    const seen: string[] = []
    const provider = createNominatimProvider(async (url) => {
      seen.push(url)
      return []
    })
    await provider.search('zug hb')
    expect(seen).toEqual(['http://127.0.0.1:3333/search'])
  })

  it('is read per call, not frozen at import', () => {
    // A module-level constant cannot be changed from outside the process, which
    // is the one thing this variable exists to allow.
    process.env.ZAEME_GEOCODER_URL = 'http://127.0.0.1:1'
    expect(geocoderBase()).toBe('http://127.0.0.1:1')
    process.env.ZAEME_GEOCODER_URL = 'http://127.0.0.1:2'
    expect(geocoderBase()).toBe('http://127.0.0.1:2')
  })

  it('folds a query the same way whatever its length', () => {
    // `foldQuery` is the folding with no opinion about length, which is what
    // lets the two out-of-bounds refusals be different sentences.
    expect(foldQuery('  Ponte   25 DE Abril ')).toBe('ponte 25 de abril')
    expect(foldQuery('x'.repeat(200))).toHaveLength(200)
    expect(foldQuery('z')).toBe('z')
  })

  it('is aimed at the stub in CI, in BOTH jobs that boot a server', () => {
    // The claim "the suite sends OpenStreetMap nothing" is a property of this
    // workflow file, and it is one line away from silently stopping being true.
    // The smoke queries are salted per run on purpose, so the cache cannot
    // spare the request: without the override every CI run is live traffic from
    // a shared address under the `zaeme/1.0` prefix production also sends.
    const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect((workflow.match(/ZAEME_GEOCODER_URL: http/g) ?? []).length).toBe(2)
    expect((workflow.match(/name: Boot the geocoder stub/g) ?? []).length).toBe(2)
    // …and booted is not the same as up: a stub that never answered would let
    // every shape assertion pass on the degrade path instead.
    expect(workflow).toMatch(/\$ZAEME_GEOCODER_URL\/healthz/)
    expect(existsSync(join(ROOT, 'scripts', 'geocoder-stub.mjs'))).toBe(true)
  })

  it('has a stub that answers the two paths in the shape the mapping parses', () => {
    // A stub that answered a different shape would make every CI run prove the
    // degrade path while reading as coverage of the feature.
    const stub = readFileSync(join(ROOT, 'scripts', 'geocoder-stub.mjs'), 'utf8')
    expect(stub).toMatch(/'\/search'/)
    expect(stub).toMatch(/'\/reverse'/)
    // Seven decimals, like the real service — so the rounding to the column's
    // six is exercised rather than pre-empted.
    expect(stub).toMatch(/lat: '38\.6894441'/)
    expect(mapNominatimResult({
      osm_type: 'way', osm_id: 4306103, lat: '38.6894441', lon: '-9.1772221',
      type: 'bridge', name: 'Ponte 25 de Abril', display_name: 'Ponte 25 de Abril, Lisboa, Portugal'
    })).toMatchObject({ lat: 38.689444, osmType: 'way' })
  })
})

/* -------------------------------- the mapping ----------------------------- */

describe('a result lands in the column by #30\'s own rule', () => {
  /** The shape Nominatim answers with (`format=jsonv2`), trimmed. */
  const raw = {
    place_id: 123,
    osm_type: 'way',
    osm_id: 4306103,
    lat: '38.6894441',
    lon: '-9.1772221',
    category: 'man_made',
    type: 'bridge',
    name: 'Ponte 25 de Abril',
    display_name: 'Ponte 25 de Abril, Lisboa, Portugal'
  }

  it('maps the fields the place table has, rounding to six decimals', () => {
    // Nominatim answers seven and the column holds six, and the rounding is
    // `normaliseCoordinates` — the same arithmetic a typed coordinate goes
    // through, so a searched place and a typed one cannot disagree.
    expect(mapNominatimResult(raw)).toEqual({
      name: 'Ponte 25 de Abril',
      address: 'Ponte 25 de Abril, Lisboa, Portugal',
      lat: 38.689444,
      lng: -9.177222,
      osmType: 'way',
      osmId: '4306103',
      category: 'bridge'
    })
  })

  it('names an unnamed result from the first line of its address', () => {
    // Most reverse lookups land on a house number, which has no `name`.
    const unnamed = { ...raw, name: '', display_name: 'Bahnhofplatz 1, 6300 Zug, Schweiz' }
    expect(mapNominatimResult(unnamed)?.name).toBe('Bahnhofplatz 1')
  })

  it('drops a result it cannot use rather than throwing away the others', () => {
    // One bad entry in a list of eight must not cost the other seven, and a
    // result with no usable position must never become a place.
    expect(mapNominatimResult({ ...raw, lat: undefined })).toBeNull()
    expect(mapNominatimResult({ ...raw, lat: 'somewhere' })).toBeNull()
    expect(mapNominatimResult({ ...raw, lat: '91.5' })).toBeNull()
    expect(mapNominatimResult({ ...raw, name: '', display_name: '' })).toBeNull()
    expect(mapNominatimResult(null)).toBeNull()
    // …and the good one beside them still maps.
    expect(mapNominatimResult(raw)).not.toBeNull()
  })

  it('never carries half an OSM reference out of a strange answer', () => {
    // An id whose type is not one of the three identifies nothing — node 12345,
    // way 12345 and relation 12345 are different features — and a half
    // reference is invisible to the unique index that keeps one feature to one
    // place per event.
    const odd = mapNominatimResult({ ...raw, osm_type: 'tile' })
    expect(odd).toMatchObject({ osmType: null, osmId: null })
    expect(odd!.lat).toBe(38.689444)
  })
})

describe('an OSM reference is both or neither', () => {
  it('keeps a hand-typed place with no reference at all', () => {
    expect(normaliseOsmRef(null, null)).toEqual({ osmType: null, osmId: null })
    expect(normaliseOsmRef(undefined, undefined)).toEqual({ osmType: null, osmId: null })
    expect(normaliseOsmRef(null, '')).toEqual({ osmType: null, osmId: null })
  })

  it('refuses one of the pair without the other', () => {
    expect(() => normaliseOsmRef('way', null)).toThrowError(/both an OpenStreetMap type and id/)
    expect(() => normaliseOsmRef(null, '4306103')).toThrowError(/both an OpenStreetMap type and id/)
  })

  it('takes the pair', () => {
    expect(normaliseOsmRef('way', ' 4306103 ')).toEqual({ osmType: 'way', osmId: '4306103' })
  })
})

/* ------------------------- where this lives, and does not ----------------- */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const API_ROOT = join(ROOT, 'server', 'api')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}
const rel = (f: string) => relative(ROOT, f).split(sep).join('/')
const handlers = walk(API_ROOT).filter(f => f.endsWith('.ts'))

/**
 * The file with its COMMENTS TAKEN OUT, for the assertions that are about what
 * the code does rather than what it says.
 *
 * Both of the checks below were written against the whole file first and both
 * were satisfied by their own explanations — the search handler's doc comment
 * says why an unreachable geocoder must not make `$fetch` throw, and the
 * migration's header says at length that it contains no FOREIGN KEY. A rule a
 * comment can break is not a rule; it is the `<NuxtPage />`-in-a-comment trap
 * in `test/api-boundary.test.ts` wearing a different hat.
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(\/\/|--)/.test(line))
    .join('\n')
}

describe('the geocoder is the planners\' and is not in the machine contract', () => {
  const geocodeRoutes = handlers.filter(f => /\/(search|reverse)\.get\.ts$/.test(rel(f)))

  it('has the two routes, on the host surface only', () => {
    expect(geocodeRoutes.map(rel).sort()).toEqual([
      'server/api/host/events/[slug]/places/reverse.get.ts',
      'server/api/host/events/[slug]/places/search.get.ts'
    ])
  })

  it('is NOT on the invite capability URL, which is the decision taken here', () => {
    // #32 as written offers this to the link as well. It is a forwardable URL,
    // and a third-party proxy behind it hands anybody it reaches the ability to
    // drive queries under this instance's identifying User-Agent — which is how
    // an instance gets blocked. Widening it is a deliberate act, and this is
    // what makes it one rather than a file somebody adds.
    const guest = handlers.filter(f => rel(f).startsWith('server/api/invites/'))
    const offenders = guest.filter(f => /geocode|nominatim|\/(search|reverse)\./i.test(rel(f))
      || /searchPlaces|reverseGeocode/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('puts none of it on /api/v1, and none of it in the spec', () => {
    // A route there becomes an MCP tool the owner never asked for, and it would
    // put a third-party dependency inside the machine contract — which another
    // repository vendors and generates from.
    const machine = handlers.filter(f => rel(f).startsWith('server/api/v1/'))
    expect(machine.filter(f => /search|reverse|geocode/i.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([])

    const spec = parse(readFileSync(join(ROOT, 'docs', 'zaeme-api.openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    expect(Object.keys(spec.paths).filter(p => /(search|reverse|geocode)/i.test(p))).toEqual([])
    const operationIds = Object.values(spec.paths)
      .flatMap(item => Object.values(item).map(op => op?.operationId))
      .filter((id): id is string => typeof id === 'string')
    expect(operationIds.filter(id => /geocode|reverse|searchPlace/i.test(id))).toEqual([])
  })

  it('may be searched by exactly the roles that may add a place', () => {
    // #48's lesson: two gates answering one feature must draw the same line, or
    // the same account is offered a search whose result it cannot save. The
    // narrow side is the one that can be widened later without taking anything
    // back, so this is `addPlaceAsPlanner`'s set and not the reader's.
    const geocode = readFileSync(join(ROOT, 'server', 'domain', 'geocode.ts'), 'utf8')
    const roles = /export const GEOCODE_ROLES = \[([^\]]*)\]/.exec(geocode)?.[1] ?? ''
    expect(roles).toMatch(/'owner'/)
    expect(roles).toMatch(/'co_planner'/)
    expect(roles).not.toMatch(/'logistics'/)

    const places = readFileSync(join(ROOT, 'server', 'domain', 'places.ts'), 'utf8')
    const addBody = /export async function addPlaceAsPlanner[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    expect(addBody).toMatch(/assertPlanner\(ev\.id, userId, \{ roles: \['owner', 'co_planner'\] \}\)/)
  })

  it('keeps the handlers thin — no fetch, no database, no cache', () => {
    expect(geocodeRoutes.length).toBe(2)
    for (const f of geocodeRoutes) {
      const src = readFileSync(f, 'utf8')
      const code = codeOnly(src)
      expect({ route: rel(f), leaks: /\$fetch|useDb\(|nominatim|User-Agent/i.test(code) })
        .toEqual({ route: rel(f), leaks: false })
      // …and both go through the session, like everything else under /api/host.
      expect(src).toMatch(/requireGuestUser\(/)
    }
  })

  it('answers 200 for an unreachable geocoder rather than a 5xx', () => {
    // An error status makes the browser's `$fetch` throw into a search box,
    // which is the failed page this issue forbids. The status is in the BODY.
    const search = codeOnly(readFileSync(join(API_ROOT, 'host', 'events', '[slug]', 'places', 'search.get.ts'), 'utf8'))
    expect(search).not.toMatch(/setResponseStatus|statusCode: 5/)
  })
})

describe('the cache is a table, and the schema says the rules', () => {
  const schema = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
  const migration = readFileSync(
    join(ROOT, 'server', 'database', 'migrations', '0008_messy_luckman.sql'), 'utf8'
  )

  it('has the geocode cache in the schema drizzle-kit reads', () => {
    expect(existsSync(join(ROOT, 'server', 'database', 'schema', 'geocode.ts'))).toBe(true)
    expect(readFileSync(join(ROOT, 'server', 'database', 'schema', 'index.ts'), 'utf8'))
      .toMatch(/export \* from '\.\/geocode'/)
    expect(migration).toMatch(/CREATE TABLE "zaeme_geocode_cache"/)
  })

  it('makes one OSM feature one place per event, in the database', () => {
    // The decision #30 deferred. PARTIAL on `osm_id is not null`: Postgres
    // counts two NULLs as distinct by default, so an index without the
    // predicate permits the same rows TODAY — the predicate says which rows
    // the rule is about, and is what stops a rebuild with `NULLS NOT DISTINCT`
    // from refusing a trip its second hand-typed place.
    expect(schema).toMatch(/uniqueIndex\('events_place_event_osm_unique'\)/)
    expect(schema).toMatch(/\.where\(sql`osm_id is not null`\)/)
    expect(schema).toMatch(/check\('events_place_osm_ref_pair'/)
    expect(migration).toMatch(/CREATE UNIQUE INDEX "events_place_event_osm_unique"[\s\S]{0,140}WHERE osm_id is not null/)
    expect(migration).toMatch(/CONSTRAINT "events_place_osm_ref_pair" CHECK \(\(osm_type is null\) = \(osm_id is null\)\)/)
  })

  it('refuses the duplicate in the domain too, naming the place already there', () => {
    // The index is the backstop for two planners at once; everybody else gets a
    // sentence. 409, not 422: nothing about the request is wrong.
    const places = readFileSync(join(ROOT, 'server', 'domain', 'places.ts'), 'utf8')
    expect(places).toMatch(/statusCode: 409/)
    expect(places).toMatch(/is already on this trip/)
    // …on BOTH writers, or the rule holds on the add and not on the edit.
    const add = /export async function addPlaceAsPlanner[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    const update = /export async function updatePlaceAsPlanner[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    expect(add).toMatch(/assertOsmRefFree\(ev\.id, ref\)/)
    expect(update).toMatch(/assertOsmRefFree\(ev\.id, ref, placeId\)/)
  })

  it('adds exactly one migration, and it carries no foreign key', () => {
    // The 42830 trap `0007_useful_loa.sql` documents: drizzle-kit emits every
    // constraint before every index, so a composite foreign key added here
    // would abort the whole migration — and with it the deploy.
    const files = readdirSync(join(ROOT, 'server', 'database', 'migrations')).filter(f => f.endsWith('.sql'))
    expect(files.filter(f => f.startsWith('0008')).length).toBe(1)
    expect(files.filter(f => /^00(09|1\d)/.test(f))).toEqual([])
    expect(codeOnly(migration)).not.toMatch(/FOREIGN KEY/i)
  })
})

describe('the card tells the two empty answers apart', () => {
  const card = readFileSync(join(ROOT, 'app', 'components', 'HostPlacesCard.vue'), 'utf8')
  const template = /<template>([\s\S]*)<\/template>\s*$/.exec(card)?.[1] ?? ''

  it('renders "unavailable" and "no matches" as different sentences', () => {
    // A single empty list says the wrong one of these half the time, and the
    // wrong one tells somebody their café does not exist.
    expect(template).toMatch(/searchState === 'unavailable'/)
    expect(template).toMatch(/searchState === 'ok'/)
    expect(template).toMatch(/Search is unavailable right now/)
    expect(template).toMatch(/No matches/)
  })

  it('debounces, and asks for more than one letter', () => {
    // A courtesy rather than the promise — the server-side gate is what keeps
    // the policy — but a request per keystroke is still somebody else's server.
    expect(card).toMatch(/const MIN_SEARCH = 3/)
    expect(card).toMatch(/setTimeout\(runSearch, DEBOUNCE_MS\)/)
    expect(card).toMatch(/clearTimeout\(searchTimer\)/)
  })

  it('drops a reply that a later keystroke has overtaken', () => {
    // Otherwise a slow lookup for "zu" lands on top of the results for "zug hb".
    expect(card).toMatch(/const seq = \+\+searchSeq/)
    expect((card.match(/if \(seq !== searchSeq\) return/g) ?? []).length).toBe(2)
  })

  it('fills the form rather than saving, and carries the OSM reference', () => {
    // The place is still added by the same POST somebody could have typed, so a
    // geocoder that is down costs the feature nothing but the typing.
    expect(card).toMatch(/function useSuggestion/)
    expect(card).toMatch(/newPlace\.osmType = s\.osmType \?\? ''/)
    expect(card).toMatch(/osmType: newPlace\.osmType \|\| null/)
    expect(card).toMatch(/osmId: newPlace\.osmId \|\| null/)
  })

  it('shows the attribution the data is licensed under', () => {
    expect(template).toMatch(/\{\{ attribution \}\}/)
  })

  it('still lets a place be added, and corrected, by hand', () => {
    // The acceptance criterion that outlives any geocoder: the name field, the
    // two coordinate fields and the edit form are all where they were.
    expect(template).toMatch(/v-model="newPlace\.name"/)
    expect(template).toMatch(/v-model="newPlace\.lat"/)
    expect(template).toMatch(/v-model="placeDraft\.lat"/)
    expect(template).toMatch(/Name this pin/)
  })
})
