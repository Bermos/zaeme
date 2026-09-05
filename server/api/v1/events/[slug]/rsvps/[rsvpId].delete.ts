import { deleteRsvp } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { REMOVED } from '../../../../../utils/v1-shapes'

/** `removeRsvp` — sparingly, and only when the user asks. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const rsvpId = getRouterParam(event, 'rsvpId')!
  await deleteRsvp(caller.planner.id, slug, rsvpId)
  return REMOVED
})
