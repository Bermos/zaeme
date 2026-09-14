import { z } from 'zod'
import { addExpenseAsPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { expense } from '#server/utils/v1-shapes'

/**
 * `addTripExpense` — participants without an explicit `amountCents` split the
 * remainder evenly. Money is integer cents throughout.
 *
 * `currency` is what was SPENT and defaults to the instance base currency;
 * anything else is converted once, at write time, and frozen onto the row
 * (#25). Pass `fxRate` to pin the conversion yourself — otherwise the rate is
 * fetched, and a fetch that comes back empty is a 422 naming this field rather
 * than an expense recorded at a rate nobody chose.
 *
 * `splitMode` (#26) divides the total another way: `exact` per-person amounts,
 * `percentage` (which must sum to 100), or `weight` — "Ana counts double" is 2,
 * and 0 leaves somebody out of this one. Under those last two each participant
 * carries `weight` instead of `amountCents`.
 *
 * It is OPTIONAL and defaults to `even`, which is precisely what this route did
 * before the field existed: a caller that never sends it sees no change in any
 * request or any response field it already reads.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  /**
   * Where the cost lands, by NAME and case-insensitively (#61): "Food", or the
   * old lower-case enum value `food`, which still resolves to the same account.
   * `other` means `Uncategorised`, which is also what leaving it out means — and
   * leaving it out is the ordinary case, because a group that does not care
   * about categories should never be asked.
   */
  category: z.string().min(1).max(60).optional(),
  /** The category account outright, from the budget's `accounts`. Wins over `category`. */
  accountId: z.string().min(1).max(64).optional(),
  amountCents: z.number().int().min(1),
  currency: z.string().min(3).max(3).optional(),
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  note: z.string().max(500).optional(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.email(),
  splitMode: z.enum(['even', 'exact', 'percentage', 'weight']).optional(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.email(),
    amountCents: z.number().int().min(0).optional(),
    weight: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional()
  }).strict()).min(1).max(50)
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  // The domain answers the whole budget plus the id it just wrote; the contract
  // answers only that one expense.
  const result = await addExpenseAsPlanner(caller.planner.id, slug, body)
  const recorded = result.expenses.find(e => e.id === result.expenseId)!
  setResponseStatus(event, 201)
  return expense(recorded)
})
