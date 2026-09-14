import { z } from 'zod'
import { moveTimelineItemAsOwner } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * Move an itinerary item one place, from `/admin`.
 *
 * The owner-gated twin of the host route next door, on the same one-statement
 * renumbering — see `applyTimelineItemMove`. This surface has no add and no
 * delete, so a reorder that quietly wedged two items would leave the owner
 * nothing to fix it with.
 */
const bodySchema = z.object({ direction: z.enum(['up', 'down']) })

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const { direction } = await readValidatedBody(e, bodySchema.parse)
  return { timeline: await moveTimelineItemAsOwner(slug, id, direction) }
})
