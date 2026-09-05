import { findAttention } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'

/**
 * `getEventsAttention` — the facts half of the daily check-in.
 *
 * Stateless and side-effect free: zäme knows nothing about threads, unread
 * guards or whether anything was said yesterday. Enterprise keeps all of that
 * and calls this only after its own guards pass, so a throttled day makes no
 * request at all. Nothing to raise is an empty `findings` array with a 200, not
 * a 404.
 */
export default defineServiceHandler(async (event, caller) => {
  const query = getQuery(event)
  const horizonDays = Number(query.horizonDays)
  const limit = Number(query.limit)
  return findAttention(caller.planner.id, {
    horizonDays: Number.isFinite(horizonDays) ? horizonDays : undefined,
    limit: Number.isFinite(limit) ? limit : undefined
  })
})
