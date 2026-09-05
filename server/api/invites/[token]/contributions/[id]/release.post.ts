import { z } from 'zod'
import { guestReleaseContribution } from '../../../../../domain/index'

/** Release one's own claim on a bring-list item. */
const bodySchema = z.object({
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await guestReleaseContribution(token, id, body.guestEmail)
  return { contribution: item }
})
