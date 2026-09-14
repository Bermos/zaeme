import { z } from 'zod'
import { addTimelineItem } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { timelineItem } from '#server/utils/v1-shapes'

/**
 * `addTimelineItem` — appended after the existing items unless `sortOrder` says
 * otherwise.
 *
 * There is no PATCH beside this and its DELETE, and that is deliberate rather
 * than a gap: itinerary items ARE editable in place on the human surfaces
 * (`PATCH /api/host/events/{slug}/timeline/{id}`), so nobody loses an item's id
 * or its pinned media to fix a typo. Withheld here is the machine verb — an
 * `updateTimelineItem` tool in the XO's vocabulary is its own decision, not yet
 * taken. The operationId is reserved for whoever takes it.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  startsAt: z.iso.datetime({ offset: true }).optional(),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  location: z.string().max(500).optional(),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']).optional(),
  sortOrder: z.number().int().min(0).max(100000).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await addTimelineItem(caller.planner.id, slug, body)
  setResponseStatus(event, 201)
  return timelineItem(created!)
})
