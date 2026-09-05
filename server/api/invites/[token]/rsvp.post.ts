import { z } from 'zod'
import { saveGuestRsvp } from '../../../domain/index'
import { dispatchEvent } from '../../../utils/dispatch'

/** Guest RSVP — shared domain logic, zäme's dispatch (confirmation email trigger). */
const bodySchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  plusOne: z.boolean().optional().default(false),
  plusOneName: z.string().max(200).optional().nullable(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const saved = await saveGuestRsvp(token, body, { dispatch: dispatchEvent })
  return { rsvp: saved }
})
