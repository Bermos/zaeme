import { z } from 'zod'
import { addContributionAsPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { contribution } from '#server/utils/v1-shapes'

/** `addPotluckItem` — something for attendees to claim. */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['food', 'drink', 'other']).optional(),
  quantity: z.string().max(100).optional(),
  // How many are wanted (#44), when that is a number at all. `quantity` above
  // is the free-text fallback and stays: "some crisps" is not a count.
  quantityNeeded: z.number().int().min(1).max(10000).optional(),
  unit: z.string().max(40).optional(),
  note: z.string().max(500).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await addContributionAsPlanner(caller.planner.id, slug, body)
  setResponseStatus(event, 201)
  return contribution(created)
})
