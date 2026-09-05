import { listRsvps } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { rsvp } from '#server/utils/v1-shapes'

/** `listRsvps` — who is coming, with the per-status summary and headcount. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const result = await listRsvps(caller.planner.id, slug)
  return { rsvps: result.rsvps.map(rsvp), summary: result.summary }
})
