/**
 * A Nominatim-shaped geocoder that answers from this file (#32).
 *
 * WHY THIS EXISTS. `scripts/api-smoke.sh` exercises the place search against a
 * real running server, and it salts its queries with the run's timestamp on
 * purpose so the cache cannot spare the request — which is the right way to
 * test a cache and the wrong thing to point at somebody else's public service.
 * That suite runs twice per CI run, on every push and every pull request, from
 * shared runner addresses, under the same `zaeme/1.0` User-Agent prefix a real
 * deployment sends. A block earned by a test suite is a block served to the
 * owner's instance, and the blocklist does not know the difference.
 *
 * So CI boots this and sets `ZAEME_GEOCODER_URL` to it. OpenStreetMap receives
 * nothing, and the smoke checks get MORE than they had: the `ok` branch, the
 * mapping, the cache write and read, and the rate limiter all run end to end
 * against an answer that is the same every time.
 *
 * It is deliberately NOT a mock of the domain: it speaks HTTP, it answers the
 * two paths Nominatim answers, in the `jsonv2` shape `mapNominatimResult`
 * parses, so everything between the route and the socket is the real thing.
 *
 * Plain .mjs with no dependencies, like `scripts/migrate.mjs` — it has to run
 * from a runner that has installed nothing but the app's own dependencies.
 *
 *   node scripts/geocoder-stub.mjs            # 127.0.0.1:3333
 *   GEOCODER_STUB_PORT=3999 node scripts/geocoder-stub.mjs
 *
 * `GET /healthz` answers 200 so a workflow can wait for it.
 */
import { createServer } from 'node:http'

const port = Number(process.env.GEOCODER_STUB_PORT || 3333)

/**
 * One result, shaped as Nominatim's `format=jsonv2`. Seven decimals on the
 * coordinates, because that is what the real service answers and the rounding
 * to the column's six is a thing worth exercising rather than pre-empting.
 */
const BRIDGE = {
  place_id: 1,
  osm_type: 'way',
  osm_id: 4306103,
  lat: '38.6894441',
  lon: '-9.1772221',
  category: 'man_made',
  type: 'bridge',
  name: 'Ponte 25 de Abril',
  display_name: 'Ponte 25 de Abril, Lisboa, Portugal',
  // What `addressdetails=1` adds, and the ONE field zäme reads out of it: the
  // country code is how a geocoded place offers the trip's display zone (#31).
  // Portugal on purpose — it has three zones, so the suggestion has to arrive
  // as a list a host chooses from rather than as one answer picked for them.
  address: { country_code: 'pt' }
}

/**
 * The stub knows ONE place and answers nothing for everything else, which is
 * the second shape the smoke suite needs: an empty list is a real answer ("no
 * such place") and has to stay distinguishable from an outage. A stub that
 * matched every query would make the "no matches" state untestable.
 */
function search(q) {
  return (q ?? '').toLowerCase().includes('ponte') ? [BRIDGE] : []
}

let served = 0

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  // Logged, and counted, because "the suite sent OpenStreetMap nothing" is a
  // claim somebody has to be able to CHECK rather than believe: the count here
  // is what says every geocoding request the app made arrived at this process.
  if (url.pathname !== '/healthz') {
    served += 1
    console.log(`[geocoder-stub] ${served} ${url.pathname}${url.search}`)
  }
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end('{"status":"ok"}')
  }
  if (url.pathname === '/search') {
    return json(search(url.searchParams.get('q')))
  }
  if (url.pathname === '/reverse') {
    // Reverse answers ONE object, not a list — including for a point with
    // nothing at it, where the real service answers `{error: …}`, which maps to
    // no suggestion and therefore to an empty, successful answer.
    const lat = Number(url.searchParams.get('lat'))
    const near = Number.isFinite(lat) && Math.abs(lat - 38.68944) < 0.01
    return json(near ? BRIDGE : { error: 'Unable to geocode' })
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[geocoder-stub] listening on http://127.0.0.1:${port}`)
})
