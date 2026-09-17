import { z } from 'zod'
import { guestAddContribution } from '../../../../domain/index'

/**
 * A guest adds a bring-list item (optionally claiming it right away).
 *
 * `quantityNeeded` and `claim` together are "I'll bring six bottles": the guest
 * states the count and meets it, which is why the claim defaults to the whole
 * need here rather than to one. A planner seeding a count for OTHERS to claim
 * uses the host surface, which adds without claiming at all.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['food', 'drink', 'other']).optional(),
  quantity: z.string().max(100).optional().nullable(),
  quantityNeeded: z.number().int().min(1).max(10000).optional().nullable(),
  unit: z.string().max(40).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
  claim: z.boolean().optional().default(true),
  claimQuantity: z.number().int().min(1).max(10000).optional(),
  guestName: z.string().min(1).max(200),
  guestEmail: z.email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await guestAddContribution(
    token,
    {
      title: body.title,
      category: body.category,
      quantity: body.quantity,
      quantityNeeded: body.quantityNeeded,
      unit: body.unit,
      note: body.note,
      claim: body.claim,
      claimQuantity: body.claimQuantity
    },
    { guestName: body.guestName, guestEmail: body.guestEmail }
  )
  return { contribution: item }
})
