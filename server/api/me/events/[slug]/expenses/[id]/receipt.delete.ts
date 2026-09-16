import { detachReceiptAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Take the receipt off an expense (#29). THE PHOTO STAYS IN THE GALLERY — this
 * un-pins, it never deletes, and there is exactly one thing in this app that
 * removes stored bytes (`DELETE /api/host/events/{slug}/media/{id}`, planner
 * only, which deletes the object too).
 *
 * Idempotent: an expense with no receipt is already in the state the caller
 * asked for, so this answers 200 rather than 404.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const budget = await detachReceiptAsParticipant(user, slug, id)
  return { budget: await signBudgetReceipts(budget) }
})
