import { z } from 'zod'
import { addTimelineItem } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Add an itinerary item (planner only) — the trip planner's building block. */
const bodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }).optional().nullable(),
  endsAt: z.string().datetime({ offset: true }).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await addTimelineItem(user.id, slug, body)
  return { item }
})
