import { listRsvps } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { rsvp } from '../../../../../utils/v1-shapes'

/** `listRsvps` — who is coming, with the per-status summary and headcount. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const result = await listRsvps(caller.planner.id, slug)
  return { rsvps: result.rsvps.map(rsvp), summary: result.summary }
})
