import { z } from 'zod'
import { addExpenseAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'
import { signBudgetReceipts } from '../../../../../utils/media-sign'

/** Record an expense as the host (owner/co-planner only). */
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
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  // The manual override (#25). Present means "do not fetch a rate" — which is
  // both the correction of a wrong one and the only way in on an instance with
  // no outbound network.
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  /**
   * WHAT THE PAYER WAS ACTUALLY OUT OF POCKET, in the trip's currency (#59) —
   * the other override, and the one somebody reading a card statement reaches
   * for. A bank charging `price × rate × fee` hands over a figure no
   * mid-market rate reproduces, and that figure is what the group splits.
   *
   * Refused beside `fxRate`: the two can disagree and picking one silently is
   * how a budget stops meaning anything.
   */
  targetAmountCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional().nullable(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.string().email(),
  // How the total is divided (#26). Omitted means `even`, which is what every
  // expense recorded before this field existed did.
  splitMode: z.enum(['even', 'exact', 'percentage', 'weight']).optional(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    amountCents: z.number().int().min(0).optional(),
    // The percentage or the share count as entered, for those two modes.
    weight: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional()
  })).min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await addExpenseAsPlanner(user.id, slug, body)
  return { budget: await signBudgetReceipts(budget) }
})
