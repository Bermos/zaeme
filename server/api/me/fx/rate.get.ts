import { z } from 'zod'
import { quoteExpenseRate } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Today's rate from a currency into the instance base, for the expense form to
 * show and let the person override before saving (#25, D4).
 *
 * It lives on the ACCOUNT surface because recording an expense does (#48) —
 * this is the preview of a write only a signed-in participant can make, and an
 * open endpoint would make zäme a free currency-conversion proxy for anyone who
 * finds it. `rate: null` is a normal answer; the form then asks for one.
 */
const querySchema = z.object({ from: z.string().length(3) })

export default defineEventHandler(async (e) => {
  await requireGuestUser(e)
  const { from } = await getValidatedQuery(e, querySchema.parse)
  return quoteExpenseRate(from)
})
