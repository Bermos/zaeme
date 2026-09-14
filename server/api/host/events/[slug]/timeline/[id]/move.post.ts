import { z } from 'zod'
import { moveTimelineItem } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Move an itinerary item one place (planner only).
 *
 * Reordering is its own verb rather than two `sortOrder` PATCHes from the
 * browser: the two-request version leaves the pair sharing a number if the
 * second one does not land, after which the arrows go dead for that pair and
 * say nothing. `applyTimelineItemMove` renumbers in one statement instead.
 *
 * Answers the whole itinerary in its new order, so the caller replaces its list
 * rather than guessing what moved.
 */
const bodySchema = z.object({ direction: z.enum(['up', 'down']) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const { direction } = await readValidatedBody(e, bodySchema.parse)
  return { timeline: await moveTimelineItem(user.id, slug, id, direction) }
})
