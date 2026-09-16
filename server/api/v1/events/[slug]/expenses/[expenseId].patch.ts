import { z } from 'zod'
import { updateExpenseAsPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { expense } from '#server/utils/v1-shapes'

/**
 * `updateTripExpense` — correct an expense in place (#27).
 *
 * ADDITIVE IN EVERY DIRECTION: a new method on a path that already exists, no
 * change to `addTripExpense`, and no field of `Expense` changes type, name or
 * meaning. A caller that never calls this sees nothing.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS UNCHANGED, which is what makes this
 * a PATCH rather than a PUT: correcting a typo means sending `title`, not
 * resending the whole entry and hoping the split round-trips. `null` clears the
 * note and moves a cost to Uncategorised.
 *
 * Leave `participants` out and the split is RE-DERIVED from what was recorded:
 * a four-way even split moved from 100 to 120 becomes four shares of 30, and a
 * 3/2/1 weight split re-apportions at the same weights. The one thing #26 did
 * not record is which people were pinned in a MIXED `even` split, and that case
 * is a 422 asking for the split rather than a guess (as is a new total on an
 * `exact` split, whose amounts were chosen against a total that no longer
 * exists).
 *
 * The conversion follows the same three rules everywhere: state `fxRate` or
 * `targetAmountCents` and the row records your figure as `manual`; change
 * `currency` and the rate is settled afresh; change only `amountCents` and the
 * rate this row was frozen at carries it, with `fxRateSource` falling back to
 * `fetched` because nobody checked the new figure.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(60).optional().nullable(),
  accountId: z.string().min(1).max(64).optional().nullable(),
  amountCents: z.number().int().min(1).optional(),
  currency: z.string().min(3).max(3).optional(),
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  targetAmountCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional().nullable(),
  paidByName: z.string().min(1).max(200).optional(),
  paidByEmail: z.email().optional(),
  splitMode: z.enum(['even', 'exact', 'percentage', 'weight']).optional(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.email(),
    amountCents: z.number().int().min(0).optional(),
    weight: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional()
  }).strict()).min(1).max(50).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const expenseId = getRouterParam(event, 'expenseId')!
  const body = bodySchema.parse(await readBody(event))
  // The domain answers the whole budget plus the id it just rewrote; the
  // contract answers only that one expense, as the write does.
  const result = await updateExpenseAsPlanner(caller.planner.id, slug, expenseId, body)
  const corrected = result.expenses.find(e => e.id === result.expenseId)!
  return expense(corrected)
})
