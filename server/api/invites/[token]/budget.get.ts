import { guestLoadBudget } from '../../../domain/index'
import { signBudgetReceipts } from '../../../utils/media-sign'

/** The trip budget refresh for the guest page. */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const budget = await guestLoadBudget(token)
  // The receipt thumbnails (#29). Signed here rather than stored, like every
  // other media read: the population that gets one is exactly the population
  // that could already fetch the same object from `GET /api/invites/{token}/
  // media`, because only gallery photos and shared documents may be pinned.
  return { budget: await signBudgetReceipts(budget) }
})
