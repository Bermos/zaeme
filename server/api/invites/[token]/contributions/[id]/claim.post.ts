import { z } from 'zod'
import { guestClaimContribution } from '../../../../../domain/index'

/** Claim an unclaimed bring-list item (409 when someone was faster). */
const bodySchema = z.object({
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await guestClaimContribution(token, id, body)
  return { contribution: item }
})
