import { z } from 'zod'
import { recordSettlementAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Say that one person paid another back (#28), as the host (owner/co-planner).
 *
 * The host page renders the same budget card as the invite page, so it needs
 * the same verb; the gate is the one every other host money write uses. The
 * body is the participant surface's body, field for field, because it is the
 * same form composing it.
 */
const bodySchema = z.object({
  fromName: z.string().min(1).max(200),
  fromEmail: z.email(),
  toName: z.string().min(1).max(200),
  toEmail: z.email(),
  amountCents: z.number().int().positive(),
  /** Only when the payment was not made in the trip's currency; see the domain. */
  currency: z.string().length(3).optional(),
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  targetAmountCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await recordSettlementAsPlanner(user.id, slug, body)
  return { budget: await signBudgetReceipts(budget) }
})
