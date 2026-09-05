import { z } from 'zod'
import { castDateVotes } from '../../../domain/index'

/** Cast/update availability votes on the event's date options (while polling). */
const bodySchema = z.object({
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email(),
  votes: z.array(z.object({
    optionId: z.string().min(1),
    answer: z.enum(['yes', 'ifneedbe', 'no'])
  })).min(1)
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const poll = await castDateVotes(token, body)
  return { poll }
})
