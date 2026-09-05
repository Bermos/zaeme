import { createHash } from 'node:crypto'
import { buildSnapshot, degradedSnapshot } from '#server/domain/index'
import { defineV1Handler } from '#server/utils/api-v1'
import { authenticateService } from '#server/utils/service-auth'
import { resolveInstancePlanner } from '#server/utils/instance'

/**
 * `getEventsSnapshot` — THE HOT PATH. Enterprise fetches this on every XO turn,
 * before any tool call, and gives it a short timeout with a stale cache behind
 * it. Three properties are contractual:
 *
 *  1. ONE GET, no fan-out — `buildSnapshot` is a single statement.
 *  2. CACHEABLE — a strong `ETag` over the payload plus
 *     `private, max-age=60, stale-while-revalidate=600`, so the shim's
 *     `If-None-Match` revalidation settles into a 304 in the steady state.
 *  3. IT DEGRADES, IT DOES NOT FAIL — the contract declares no 5xx here at all.
 *
 * (3) is why this is the one operation that does not use `defineServiceHandler`.
 * That wrapper resolves the planner from the database as part of authenticating,
 * and an unreachable database would therefore answer 500 — in every
 * conversation, before the XO has said a word. So the CREDENTIAL is checked
 * first, which needs no database and so still answers 401/403 honestly, and only
 * then is the planner looked up; if that fails, or the snapshot query fails, the
 * answer is a valid snapshot with `degraded: true` and a 200.
 *
 * The ETag is computed over the payload MINUS `generatedAt`, which changes on
 * every call by construction: including it would make every validator unique and
 * the 304 unreachable.
 */
export default defineV1Handler(async (event) => {
  authenticateService(event)

  const requested = Number(getQuery(event).upcomingLimit)
  const planner = await resolveInstancePlanner().catch((err) => {
    console.error('[zaeme:snapshot] could not resolve the planner', err)
    return null
  })
  const snapshot = planner
    ? await buildSnapshot(planner.id, { upcomingLimit: Number.isFinite(requested) ? requested : undefined })
    : degradedSnapshot()

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
