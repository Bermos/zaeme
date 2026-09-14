import { z } from 'zod'
import { addExpenseAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Record an expense as a signed-in participant of the event (#48).
 *
 * This is the surface expense writes moved TO. It is not `/api/host/**` —
 * that means planner, and a friend splitting an Airbnb is not one — and it is
 * emphatically not `/api/invites/**`, where the link is the credential and a
 * session check would break the boundary `test/api-boundary.test.ts` exists to
 * hold. `assertParticipant` (in the domain) decides who belongs on the event.
 *
 * `paidBy*` names the PAYER, who need not be the caller: recording on a
 * friend's behalf is the point. Who typed it in is recorded from the session,
 * never from the body.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['travel', 'accommodation', 'food', 'tickets', 'other']).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  note: z.string().max(500).optional().nullable(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.email(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.email(),
    amountCents: z.number().int().min(0).optional()
  })).min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await addExpenseAsParticipant(user, slug, body)
  return { budget }
})
