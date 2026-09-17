import { z } from 'zod'
import { guestClaimContribution } from '../../../../../domain/index'

/**
 * Claim some of a bring-list item (409 when the item is already fully spoken
 * for). `quantity` is how many of the item's unit the guest is bringing — one
 * by default, which is what a claim on an item with no stated count has always
 * meant.
 */
const bodySchema = z.object({
  guestName: z.string().min(1).max(200),
  guestEmail: z.email(),
  quantity: z.number().int().min(1).max(10000).optional()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await guestClaimContribution(token, id, body)
  return { contribution: item }
})
