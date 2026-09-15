import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { normaliseCoordinates } from '../server/domain/places'
import { mergeItinerary } from '../app/utils/itinerary-order'

/**
 * Places, and the legs between them (#30).
 *
 * Three things are pinned here and they are the three that do not need a
 * database to be wrong: the coordinate rule, the order the two kinds of entry
 * appear in on one screen, and WHERE these routes live — which is the half of
 * this issue that a green pipeline would otherwise say nothing about.
 *
 * The rest of it — the cascade when a place is deleted, the renumbering when a
 * leg moves, the guest write arriving over a capability URL — is executed by
 * `scripts/api-smoke.sh` against a built server and a real Postgres, because
 * every one of those is a statement Postgres runs and not a function that takes
 * an array and returns one.
 */

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

/** The status a refusal came back with — a 422 is the domain having read it. */
function refusal(fn: () => unknown): { statusCode?: number, message?: string } {
  try {
    fn()
  } catch (err) {
    return err as { statusCode?: number, message?: string }
  }
  throw new Error('expected a refusal, got none')
}

describe('a place may have no coordinates, and never half of one', () => {
  it('keeps a hand-typed place with nothing but a name', () => {
    // THE STATE THIS TABLE EXISTS TO KEEP. "Ana's flat" is a place and will
    // never be geocoded; #32 has to be able to leave it alone.
    expect(normaliseCoordinates(null, null)).toEqual({ lat: null, lng: null })
    expect(normaliseCoordinates(undefined, undefined)).toEqual({ lat: null, lng: null })
    // An empty form field is "not given", not "zero degrees" — 0,0 is a real
    // place in the Atlantic and nobody's trip starts there by accident.
    expect(normaliseCoordinates('', '')).toEqual({ lat: null, lng: null })
  })

  it('takes a coordinate as typed', () => {
    // `8.95105`, not `8.951050`: the trailing zero is not significant and
    // Postgres pads it back to the column's scale on read. What matters is that
    // the number is unchanged, which is why the expectation is written out here
    // rather than derived from the answer.
    expect(normaliseCoordinates(46.004512, 8.951050)).toEqual({ lat: '46.004512', lng: '8.95105' })
    expect(normaliseCoordinates('46.004512', '8.951050')).toEqual({ lat: '46.004512', lng: '8.95105' })
    expect(normaliseCoordinates(-33.8688, 151.2093)).toEqual({ lat: '-33.8688', lng: '151.2093' })
  })

  it('rounds to the six decimals the column holds, rather than letting Postgres do it', () => {
    // Nominatim answers seven (#32) and a browser's own arithmetic can produce
    // seventeen. 47.3768866 rounds to 47.376887 — about 11 cm — and the
    // expected value is the one this test worked out, not one read back out of
    // the answer.
    expect(normaliseCoordinates('47.3768866', '8.5416578')).toEqual({ lat: '47.376887', lng: '8.541658' })
    expect(normaliseCoordinates(47.37688659999999, 8.5)).toEqual({ lat: '47.376887', lng: '8.5' })
  })

  it('refuses one of the pair without the other', () => {
    // Half a coordinate draws on a map at the wrong spot and clusters with
    // whatever shares its meridian. 422, not 400: the domain understood it.
    const only = refusal(() => normaliseCoordinates(46.004512, null))
    expect(only.statusCode).toBe(422)
    expect(only.message).toMatch(/both a latitude and a longitude, or neither/)
    expect(refusal(() => normaliseCoordinates(null, 8.951050)).statusCode).toBe(422)
    expect(refusal(() => normaliseCoordinates('', '8.95')).statusCode).toBe(422)
  })

  it('refuses degrees that are not on the planet', () => {
    expect(refusal(() => normaliseCoordinates(91, 0)).message).toMatch(/Latitude must be between -90 and 90/)
    expect(refusal(() => normaliseCoordinates(-90.000001, 0)).message).toMatch(/Latitude/)
    expect(refusal(() => normaliseCoordinates(0, 180.5)).message).toMatch(/Longitude must be between -180 and 180/)
    // …and the two limits are different numbers, which is the point of asking
    // twice: a latitude of 150 is a bug a shared bound would wave through.
    expect(refusal(() => normaliseCoordinates(150, 150)).message).toMatch(/Latitude/)
    expect(normaliseCoordinates(90, 180)).toEqual({ lat: '90', lng: '180' })
  })

  it('refuses something that is not a number at all', () => {
    for (const bad of ['abc', '1e3', '4 6', '--1', '46,0045']) {
      expect(refusal(() => normaliseCoordinates(bad, '8.95')).statusCode).toBe(422)
    }
  })
})

/**
 * The merged order. Every fixture below is LOPSIDED on purpose: an itinerary
 * whose items are evenly spaced and whose legs sit between them is ordered the
 * same way by half a dozen wrong rules, and proves none of them.
 */
describe('legs and items read as one itinerary', () => {
  const item = (id: string, startsAt: string | null) => ({ id, startsAt })
  const leg = (id: string, departsAt: string | null, sortOrder = 0, createdAt = '2027-06-01T00:00:00.000Z') => ({
    id, departsAt, sortOrder, createdAt
  })

  it('slots a leg in ahead of the first item that starts after it', () => {
    const items = [
      item('breakfast', '2027-06-01T09:00:00.000Z'),
      item('checkin', '2027-06-01T11:00:00.000Z'),
      item('dinner', '2027-06-01T19:30:00.000Z'),
      item('cheese', null)
    ]
    const legs = [
      leg('train', '2027-06-01T09:14:00.000Z', 0),
      leg('stroll', '2027-06-01T19:00:00.000Z', 10),
      leg('nightbus', '2027-06-01T22:40:00.000Z', 20),
      leg('walked-back', null, 30),
      leg('walked-out', null, 40)
    ]
    // Worked out from the rule, not from the answer: the 09:14 is after
    // breakfast and before check-in, the 19:00 stroll before dinner, the 22:40
    // bus after everything with a clock on it, and the two timeless walks last
    // in their own order. `cheese` keeps its place in the ITEM order, which is
    // where the host put it, and flushes no legs because it names no time.
    expect(mergeItinerary(items, legs).map(e => e.id)).toEqual([
      'breakfast', 'train', 'checkin', 'stroll', 'dinner', 'cheese', 'nightbus', 'walked-back', 'walked-out'
    ])
  })

  it('leaves an itinerary with no legs exactly as it was given', () => {
    // The acceptance criterion, and the reason this is an insertion rather than
    // a sort: the host's order is `sort_order`, which the up/down arrows write,
    // and here it deliberately disagrees with the clock. Sorting by time would
    // reverse these two and silently undo the reorder.
    const items = [item('evening', '2027-06-01T18:00:00.000Z'), item('morning', '2027-06-01T09:00:00.000Z')]
    expect(mergeItinerary(items, []).map(e => e.id)).toEqual(['evening', 'morning'])
    expect(mergeItinerary(items, []).every(e => e.kind === 'item')).toBe(true)
  })

  it('puts a leg that departs on an item\'s start time before it', () => {
    // You leave, then you arrive somewhere. The two entries share a timestamp,
    // so nothing but the rule decides this one.
    const items = [item('platform', '2027-06-01T09:14:00.000Z')]
    expect(mergeItinerary(items, [leg('train', '2027-06-01T09:14:00.000Z')]).map(e => e.id))
      .toEqual(['train', 'platform'])
  })

  it('orders timeless legs by sort_order, then created_at, then id', () => {
    // The same four keys `applyItineraryLegMove` renumbers from. `id` last is
    // not decoration: these two share a sort_order AND a created_at to the
    // microsecond, which is what rows written in one statement do, and cuid2
    // ids do not sort by age — so without it the list and the arrows disagree
    // about which row is where.
    const legs = [
      leg('zulu', null, 10, '2027-06-01T08:00:00.000Z'),
      leg('alpha', null, 10, '2027-06-01T08:00:00.000Z'),
      leg('first', null, 5, '2027-06-01T23:00:00.000Z'),
      leg('later', null, 10, '2027-06-01T07:00:00.000Z')
    ]
    expect(mergeItinerary([], legs).map(e => e.id)).toEqual(['first', 'later', 'alpha', 'zulu'])
  })

  it('carries the whole row through, so nothing has to be looked up again', () => {
    const [entry] = mergeItinerary([], [{ ...leg('train', null), mode: 'train' as const }])
    expect(entry).toMatchObject({ kind: 'leg', id: 'train', leg: { mode: 'train' } })
  })
})

/**
 * WHERE THESE ROUTES LIVE, which is the constraint #30 says is the one most
 * likely to be got wrong here. Enterprise generates its MCP tool surface from
 * `docs/zaeme-api.openapi.yaml`, so a place or a leg route added under
 * `/api/v1` is a verb handed to the model that nobody decided to give it — and
 * `test/api-contract.test.ts`'s bijection would then demand the spec move too,
 * which obliges a vendored-snapshot follow-up in another repository.
 */
describe('the trip\'s map is a human surface, and only a human surface', () => {
  const machine = handlers.filter(f => rel(f).startsWith('server/api/v1/'))
  const guest = handlers.filter(f => rel(f).startsWith('server/api/invites/'))
  const host = handlers.filter(f => rel(f).startsWith('server/api/host/'))

  it('has the host CRUD it needs', () => {
    const base = join(API_ROOT, 'host', 'events', '[slug]')
    for (const f of [
      join(base, 'places', 'index.get.ts'),
      join(base, 'places', 'index.post.ts'),
      join(base, 'places', '[id].patch.ts'),
      join(base, 'places', '[id].delete.ts'),
      join(base, 'legs', 'index.post.ts'),
      join(base, 'legs', '[id].patch.ts'),
      join(base, 'legs', '[id].delete.ts'),
      join(base, 'legs', '[id]', 'move.post.ts')
    ]) {
      expect({ route: rel(f), exists: existsSync(f) }).toEqual({ route: rel(f), exists: true })
    }
  })

  it('lets the invite link add a leg, and read the map', () => {
    // "We ended up walking" happens while the host is asleep, so this one write
    // is the link's. Reading is the link's as it is everywhere else here.
    expect(existsSync(join(API_ROOT, 'invites', '[token]', 'legs.post.ts'))).toBe(true)
    expect(existsSync(join(API_ROOT, 'invites', '[token]', 'places.get.ts'))).toBe(true)
  })

  it('does not let the invite link mint, edit or remove places', () => {
    // A guest says how they travelled between the points of the trip; adding
    // points to it is planning. Widening that is the owner's call, not a side
    // effect of the leg write landing here.
    const placeWrites = guest.filter(f => /places/.test(rel(f)) && !/\.get\.ts$/.test(rel(f)))
    expect(placeWrites.map(rel)).toEqual([])
  })

  it('files a leg written over the link as what HAPPENED, never as the plan', () => {
    // The column is the difference between "the 09:14 we intend to take" and
    // "the bus we actually got on". A forwarded link may say the second and not
    // the first, so `isPlanned` is absent from the guest schema — and the
    // domain, not the handler, is what puts the false in.
    const route = readFileSync(join(API_ROOT, 'invites', '[token]', 'legs.post.ts'), 'utf8')
    const schema = /const bodySchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(route)?.[1] ?? ''
    expect(schema).not.toBe('')
    expect(schema).not.toMatch(/isPlanned/)

    const places = readFileSync(join(ROOT, 'server', 'domain', 'places.ts'), 'utf8')
    expect(places).toMatch(/insertLeg\(eventId, \{ \.\.\.input, isPlanned: false \}\)/)

    // …while the host surface means the opposite when it says nothing.
    const hostRoute = readFileSync(join(API_ROOT, 'host', 'events', '[slug]', 'legs', 'index.post.ts'), 'utf8')
    expect(hostRoute).toMatch(/isPlanned: body\.isPlanned \?\? true/)
  })

  it('puts none of it on the machine surface', () => {
    const offenders = machine.filter(f => /\/(places|legs)[./]/.test(rel(f)))
    expect(offenders.map(rel)).toEqual([])
  })

  it('and declares none of it in the contract Enterprise generates from', () => {
    // Asserted over the DECLARED paths and operationIds rather than by grepping
    // the document for a word: that file carries long prose, including a comment
    // reserving `updateTimelineItem` for whoever decides to give the XO that
    // verb, and a "does not mention" check fails on a comment while passing on
    // a real route.
    const spec = parse(readFileSync(join(ROOT, 'docs', 'zaeme-api.openapi.yaml'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }
    const paths = Object.keys(spec.paths)
    expect(paths.filter(p => /\/(places|legs)\b/.test(p))).toEqual([])

    const operationIds = Object.values(spec.paths)
      .flatMap(item => Object.values(item).map(op => op?.operationId))
      .filter((id): id is string => typeof id === 'string')
    expect(operationIds.filter(id => /place|leg/i.test(id))).toEqual([])
  })

  it('keeps the whole thing in the domain, with thin handlers', () => {
    // A handler that reached for the database itself would be the place the
    // next surface copies from.
    const routes = [...host, ...guest].filter(f => /\/(places|legs)[./]/.test(rel(f)))
    expect(routes.length).toBeGreaterThan(5)
    for (const f of routes) {
      expect({ route: rel(f), db: /useDb\(|drizzle-orm/.test(readFileSync(f, 'utf8')) }).toEqual({ route: rel(f), db: false })
    }
  })
})

/**
 * The parts of the schema that are decisions rather than columns. Nothing in CI
 * reads a comment, so the few that carry a rule are pinned to the code that
 * keeps it.
 */
describe('the schema says what it means', () => {
  const schema = readFileSync(join(ROOT, 'server', 'database', 'schema', 'events.ts'), 'utf8')
  const places = readFileSync(join(ROOT, 'server', 'domain', 'places.ts'), 'utf8')

  it('keeps the free-text location beside the new pin', () => {
    // An itinerary item that never had a place must render exactly as it did
    // before this issue. Dropping `location` for `place_id` would be a silent
    // data loss on every event that is not a trip.
    expect(schema).toMatch(/location: text\('location'\)/)
    expect(schema).toMatch(/placeId: text\('place_id'\).*onDelete: 'set null'/)
  })

  it('stores a coordinate as exact decimal, at the precision arithmetic needs', () => {
    // `numeric(9, 6)`: six decimals is ~11 cm, three integer digits covers a
    // longitude. A float column would round what was typed; a text column could
    // not be compared, ordered or put in a bounding box at all, which is what
    // the map (#33) will want them for.
    expect(schema).toMatch(/lat: numeric\('lat', \{ precision: 9, scale: 6 \}\)/)
    expect(schema).toMatch(/lng: numeric\('lng', \{ precision: 9, scale: 6 \}\)/)
    // …and nothing about them is NOT NULL: a place with no coordinates is the
    // first-class state, not a row waiting to be finished.
    expect(schema).not.toMatch(/lat: numeric\([^)]*\)[^\n]*notNull/)
  })

  it('cannot leave a leg pointing at another trip\'s place', () => {
    // The composite foreign key is what makes that the database's problem
    // rather than every future caller's. `restrict`, not `set null`: the
    // deletion order is explicit in `deletePlaceAsPlanner` instead.
    expect(schema).toMatch(/foreignColumns: \[place\.eventId, place\.id\]/)
    expect(schema).toMatch(/events_itinerary_leg_event_from_place_fk/)
    expect(schema).toMatch(/events_itinerary_leg_event_to_place_fk/)
    expect(schema).toMatch(/uniqueIndex\('events_place_event_id_unique'\)/)
  })

  it('removes a place in one transaction, both-ends legs first', () => {
    // Out of order, the two updates would null one endpoint each and leave
    // exactly the journey-from-nowhere-to-nowhere the delete exists to avoid.
    const body = /export async function deletePlaceAsPlanner[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    expect(body).toMatch(/db\.transaction/)
    expect(body.indexOf('.delete(tables.itineraryLeg)')).toBeGreaterThan(-1)
    expect(body.indexOf('.delete(tables.itineraryLeg)')).toBeLessThan(body.indexOf('fromPlaceId: null'))
    expect(body.indexOf('fromPlaceId: null')).toBeLessThan(body.indexOf('.delete(tables.place)'))
  })

  it('renumbers a leg move the way the itinerary does, in one statement', () => {
    // The two-PATCH version leaves a pair sharing a number when the second does
    // not land, and the arrows then answer 200 and move nothing, for good. The
    // `for update` is not decoration either: without it a concurrent move can
    // create the very tie this exists to remove.
    const body = /export async function applyItineraryLegMove[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    expect(body).toMatch(/order by id for update/)
    expect(body).toMatch(/row_number\(\) over \(order by sort_order, departs_at nulls last, created_at, id\)/)
    expect(body).toMatch(/where t\.id = renumbered\.id\n\s*and t\.event_id = \$\{eventId\}/)
    // One UPDATE, not two: a pair of writes is the shape that half-applies.
    expect((body.match(/update events_itinerary_leg/g) ?? []).length).toBe(1)
  })

  it('reads the legs BEFORE the places it names them from', () => {
    // The lookup side has to be read second or the map is not a superset: a
    // place created between the two statements leaves a leg whose endpoint is
    // missing and whose name renders as nothing. `loadBudget` had exactly this
    // bug with accounts and lines.
    const body = /export async function loadGeography[\s\S]*?\n}/.exec(places)?.[0] ?? ''
    expect(body.indexOf('from(tables.itineraryLeg)')).toBeGreaterThan(-1)
    expect(body.indexOf('from(tables.itineraryLeg)')).toBeLessThan(body.indexOf('from(tables.place)'))
  })
})
