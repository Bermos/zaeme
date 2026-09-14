import { z } from 'zod'
import { addCategoryAccountAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Add a category account to this event (#61) — "Ski pass", "Petrol".
 *
 * Whoever may record an expense may add the category they are about to record
 * it into; two gates disagreeing about one budget verb is how a role
 * restriction stops meaning anything. Names are unique per event, so a second
 * "Food" is a 409 rather than a picker with two identical entries in it.
 */
const bodySchema = z.object({
  name: z.string().min(1).max(60)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const accounts = await addCategoryAccountAsParticipant(user, slug, body.name)
  setResponseStatus(e, 201)
  return { accounts }
})
