import { detachReceiptAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/** Take the receipt off an expense, as a planner. The photo stays (#29). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const budget = await detachReceiptAsPlanner(user.id, slug, id)
  return { budget: await signBudgetReceipts(budget) }
})
