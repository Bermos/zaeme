import { z } from 'zod'
import { createPlannerInvite } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { publicUrl } from '#server/utils/public-url'
import { plannerInvite } from '#server/utils/v1-shapes'

/**
 * `inviteCoOrganizer` — whoever opens the link and signs in to zäme becomes a
 * co-planner. The link is assembled here so Enterprise never has to know zäme's
 * route shape.
 */
const bodySchema = z.object({
  email: z.email().optional(),
  role: z.enum(['co_planner', 'logistics']).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await createPlannerInvite(caller.planner.id, slug, body)
  setResponseStatus(event, 201)
  return plannerInvite(created, publicUrl(`/host/join/${created.token}`))
})
