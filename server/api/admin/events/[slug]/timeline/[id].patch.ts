import { z } from 'zod'
import { updateTimelineItemAsOwner } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * Correct an itinerary item from `/admin` — the owner-side half of issue #8.
 *
 * Same fields as the host route next door (`/api/host/events/:slug/timeline/:id`),
 * `sortOrder` included, because an item that cannot move can only be deleted
 * and rebuilt. What differs is only who is allowed: the owner gate rather than
 * the event's planning team.
 *
 * Still absent from `docs/zaeme-api.openapi.yaml` on purpose: adding it there
 * would mint an `updateTimelineItem` tool for the XO that nobody decided to
 * give the model.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  startsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  endsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  /** Pin the item to one of the event's places, or null to unpin it (#30). */
  placeId: z.string().min(1).max(64).optional().nullable(),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']).optional(),
  icon: z.string().max(100).optional().nullable(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return { item: await updateTimelineItemAsOwner(slug, id, body) }
})
