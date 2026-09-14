import { eventTimelineAsOwner } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * One event's itinerary, for the instance administration surface.
 *
 * Unlike the host route this does not ask whether the owner plans that
 * particular event — see `eventTimelineAsOwner`.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { timeline: await eventTimelineAsOwner(getRouterParam(e, 'slug')!) }
})
