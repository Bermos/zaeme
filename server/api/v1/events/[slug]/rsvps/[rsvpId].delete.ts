import { deleteRsvp } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { REMOVED } from '#server/utils/v1-shapes'

/** `removeRsvp` — sparingly, and only when the user asks. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const rsvpId = getRouterParam(event, 'rsvpId')!
  await deleteRsvp(caller.planner.id, slug, rsvpId)
  return REMOVED
})
