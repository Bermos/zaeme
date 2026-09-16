import { removeSettlementAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Take back a payment somebody recorded (#28).
 *
 * ANYONE WHO MAY RECORD ONE MAY REMOVE ONE, which is wider than removing an
 * expense on purpose: a settlement is a claim that money changed hands in the
 * physical world, and a mistyped one that nobody can undo leaves the ledger
 * asserting a transfer that never happened. Who recorded it is on the entry;
 * who removed it is in the audit log.
 *
 * It refuses an EXPENSE id — this is not a way around `removeExpense`'s rule.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const budget = await removeSettlementAsParticipant(user, slug, id)
  return { budget: await signBudgetReceipts(budget) }
})
