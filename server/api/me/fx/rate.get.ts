import { z } from 'zod'
import { quoteExpenseRate } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Today's rate from a currency into the one a trip settles in, for the expense
 * form to show and let the person override before saving (#25 D4, #59).
 *
 * `to` is the trip's currency and the form passes it; without it the answer is
 * quoted into the instance default, which is what a caller with no trip in hand
 * is asking about.
 *
 * A SUGGESTION. `rate: null` is a normal answer, and so is a rate the person
 * then ignores: what their bank charged is what the group splits, and the write
 * takes their figure over this one.
 *
 * It lives on the ACCOUNT surface because recording an expense does (#48) —
 * this is the preview of a write only a signed-in participant can make, and an
 * open endpoint would make zäme a free currency-conversion proxy for anyone who
 * finds it.
 */
const querySchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3).optional()
})

export default defineEventHandler(async (e) => {
  await requireGuestUser(e)
  const { from, to } = await getValidatedQuery(e, querySchema.parse)
  return quoteExpenseRate(from, to)
})
