import { z } from 'zod'
import { updateExpenseAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Correct an expense as the host (owner/co-planner only) — #27.
 *
 * The same shape as the participant surface's PATCH and a different gate, which
 * is the same division `POST` on these two surfaces already has. Every field is
 * optional and absent means unchanged; `null` clears the note and moves a cost
 * to Uncategorised.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(60).optional().nullable(),
  accountId: z.string().min(1).max(64).optional().nullable(),
  amountCents: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  // Either one states what it cost and records the row as checked; neither
  // leaves an edited amount on the rate this expense was frozen at.
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
  })).min(1).max(50).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await updateExpenseAsPlanner(user.id, slug, id, body)
  return { budget: await signBudgetReceipts(budget) }
})
