import { z } from 'zod'
import { addTimelineItem } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { timelineItem } from '../../../../../utils/v1-shapes'

/**
 * `addTimelineItem` — appended after the existing items unless `sortOrder` says
 * otherwise.
 *
 * There is no PATCH beside this and its DELETE: editing an item in place is a
 * known gap carried across the boundary unchanged (Bermos/zaeme#8). The
 * operationId `updateTimelineItem` is reserved for the fix.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(5000).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
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
