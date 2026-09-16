import { removeExpenseAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Remove an expense you recorded or paid — or any of them, if you plan the
 * event. The caller is the session, so there is no `?email=` to assert with:
 * that query parameter went away with the guest write path (#48).
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const budget = await removeExpenseAsParticipant(user, slug, id)
  return { budget: await signBudgetReceipts(budget) }
})
