import { z } from 'zod'
import { attachReceiptAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/** Pin a gallery photo to an expense as its receipt, as a planner (#29). */
const bodySchema = z.object({
  mediaId: z.string().min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await attachReceiptAsPlanner(user.id, slug, id, body.mediaId)
  return { budget: await signBudgetReceipts(budget) }
})
