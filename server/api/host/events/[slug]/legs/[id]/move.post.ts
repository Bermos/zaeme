import { z } from 'zod'
import { moveLegAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Move a leg one place in the order (owner/co-planner only).
 *
 * Its own verb rather than two `sortOrder` PATCHes from the browser, for the
 * reason the itinerary's move handler gives at length: the two-request version
 * leaves a pair sharing a number if the second one does not land, and from then
 * on the arrows answer 200 and move nothing. `applyItineraryLegMove` renumbers
 * the whole list in one statement.
 *
 * Answers the whole map in its new order, so the caller replaces its lists
 * rather than guessing what moved.
 */
const bodySchema = z.object({ direction: z.enum(['up', 'down']) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const { direction } = await readValidatedBody(e, bodySchema.parse)
  return moveLegAsPlanner(user.id, slug, id, direction)
})
