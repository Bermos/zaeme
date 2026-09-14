import { z } from 'zod'
import { addCategoryAccountAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Add a category account to this event (owner/co-planner only). */
const bodySchema = z.object({
  name: z.string().min(1).max(60)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const accounts = await addCategoryAccountAsPlanner(user.id, slug, body.name)
  setResponseStatus(e, 201)
  return { accounts }
})
