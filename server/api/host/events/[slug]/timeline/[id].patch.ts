import { z } from 'zod'
import { updateTimelineItem } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/**
 * Correct an itinerary item (planner only) — restored from the pre-merge zäme
 * (`server/api/events/[slug]/timeline/[id].ts`, issue #8). Without it the only
 * way to fix a typo is delete-and-re-add, which loses the item's position.
 *
 * `sortOrder` is patchable so an item can be MOVED rather than rebuilt.
 *
 * Host surface only. This is deliberately absent from
 * `docs/zaeme-api.openapi.yaml`: adding it there would mint an XO tool
 * (`updateTimelineItem`) that nobody decided to give the model.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  startsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  endsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']).optional(),
  icon: z.string().max(100).optional().nullable(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return { item: await updateTimelineItem(user.id, slug, id, body) }
})
