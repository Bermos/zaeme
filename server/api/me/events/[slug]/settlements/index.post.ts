import { z } from 'zod'
import { recordSettlementAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Say that one person paid another back (#28), as a signed-in participant.
 *
 * The same credential as every other money write on this surface (#48): a
 * session plus standing on the event, decided in the domain by the very
 * function the expense writes use. The two people named are not the caller —
 * recording a transfer on a friend's behalf is the point, and who typed it is
 * taken from the session and never from the body.
 *
 * What is written is an ENTRY, not a row in a settlements table: payer the
 * sender, one share to the recipient, no category. See
 * `server/domain/settlements.ts`.
 */
const bodySchema = z.object({
  fromName: z.string().min(1).max(200),
  fromEmail: z.email(),
  toName: z.string().min(1).max(200),
  toEmail: z.email(),
  /** What was handed over. A partial payment is an ordinary amount here. */
  amountCents: z.number().int().positive(),
  /**
   * What it was handed over IN, when that is not the trip's currency. The
   * screen never sends this — the plan is denominated in the trip's currency
   * and "mark as paid" prefills from it — and the domain converts it exactly
   * as it converts an expense when somebody does.
   */
  currency: z.string().length(3).optional(),
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  targetAmountCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await recordSettlementAsParticipant(user, slug, body)
  return { budget: await signBudgetReceipts(budget) }
})
