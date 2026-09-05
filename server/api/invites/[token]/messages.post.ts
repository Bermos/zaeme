import { z } from 'zod'
import { guestPostMessage } from '../../../domain/index'

/** Post to the event chat via the invite link (guest identity = name+email). */
const bodySchema = z.object({
  body: z.string().min(1).max(2000),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const message = await guestPostMessage(token, body.body, {
    guestName: body.guestName,
    guestEmail: body.guestEmail
  })
  return { message }
})
