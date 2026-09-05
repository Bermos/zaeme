import { z } from 'zod'
import { addContributionAsPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { contribution } from '../../../../../utils/v1-shapes'

/** `addPotluckItem` — something for attendees to claim. */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['food', 'drink', 'other']).optional(),
  quantity: z.string().max(100).optional(),
  note: z.string().max(500).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await addContributionAsPlanner(caller.planner.id, slug, body)
  setResponseStatus(event, 201)
  return contribution(created!)
})
