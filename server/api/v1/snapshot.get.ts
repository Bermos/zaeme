import { createHash } from 'node:crypto'
import { buildSnapshot } from '../../domain/index'
import { defineServiceHandler } from '../../utils/service-auth'

/**
 * `getEventsSnapshot` — THE HOT PATH. Enterprise fetches this on every XO turn,
 * before any tool call, and gives it a short timeout with a stale cache behind
 * it. Three properties are contractual:
 *
 *  1. ONE GET, no fan-out — `buildSnapshot` is a single statement.
 *  2. CACHEABLE — a strong `ETag` over the payload plus
 *     `private, max-age=60, stale-while-revalidate=600`, so the shim's
 *     `If-None-Match` revalidation settles into a 304 in the steady state.
 *  3. IT DEGRADES, IT DOES NOT FAIL — a cold or unreadable database still
 *     answers 200 with `degraded: true`. Routing must never break on a cold
 *     database, and a 5xx here would be felt in every conversation.
 *
 * The ETag is computed over the payload MINUS `generatedAt`, which changes on
 * every call by construction: including it would make every validator unique
 * and the 304 unreachable.
 */
export default defineServiceHandler(async (event, caller) => {
  const query = getQuery(event)
  const requested = Number(query.upcomingLimit)
  const snapshot = await buildSnapshot(caller.planner.id, {
    upcomingLimit: Number.isFinite(requested) ? requested : undefined
  })

  const { generatedAt: _generatedAt, ...stable } = snapshot
  const etag = `"${createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)}"`

  setHeader(event, 'cache-control', 'private, max-age=60, stale-while-revalidate=600')
  setHeader(event, 'etag', etag)

  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return null
  }
  return snapshot
})
