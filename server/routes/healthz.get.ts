import { sql } from 'drizzle-orm'
import { useDb } from '../utils/db'

/**
 * Readiness, for Kitchen's `runtime.health.path`.
 *
 * 2xx means "this replica can actually serve a request", which for zäme means
 * the database answers — every page that matters reads from it, and a process
 * that booted with an unreachable Postgres is not ready no matter how happily
 * it holds the socket open. A TCP connect could not tell those apart, which is
 * the reason to declare a path at all.
 *
 * Deliberately cheap (`select 1`) and deliberately silent about details: it is
 * an unauthenticated endpoint, so it says ok or it fails.
 */
export default defineEventHandler(async (event) => {
  try {
    await useDb().execute(sql`select 1`)
  } catch (err) {
    console.error('[healthz] database unreachable', err)
    setResponseStatus(event, 503)
    return { status: 'unavailable' }
  }
  return { status: 'ok' }
})
