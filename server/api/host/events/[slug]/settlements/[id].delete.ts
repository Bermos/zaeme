import { removeSettlementAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Take back a payment somebody recorded (#28), as the host.
 *
 * It answers the whole budget rather than `{ removed: true }`, unlike the host
 * surface's expense delete: the card re-renders from one response, and a
 * settlement's removal changes every balance on screen.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const budget = await removeSettlementAsPlanner(user.id, slug, id)
  return { budget: await signBudgetReceipts(budget) }
})
