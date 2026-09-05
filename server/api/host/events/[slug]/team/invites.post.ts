import { z } from 'zod'
import { createPlannerInvite } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Mint a co-organizer link — whoever accepts becomes a planner on this event. */
const bodySchema = z.object({
  email: z.string().email().optional().nullable(),
  role: z.enum(['co_planner', 'logistics']).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const invite = await createPlannerInvite(user.id, slug, body)
  return { invite }
})
