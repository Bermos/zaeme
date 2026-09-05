import { z } from 'zod'
import { updateRsvp } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/**
 * Correct an RSVP on the host's behalf — "Mo texted me, he's in after all".
 *
 * The Enterprise Events department gave the owner this (its `rsvps/[rsvpId]`
 * PATCH/DELETE pair) and zäme's own host surface never had it; with Events
 * deleted from Enterprise (ADR-0036) this is where it has to live. The domain
 * function was already here — only the host route was missing.
 */
const bodySchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']).optional(),
  plusOne: z.boolean().optional(),
  plusOneName: z.string().max(200).optional().nullable(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  guestName: z.string().max(200).optional().nullable(),
  guestEmail: z.email().max(320).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return { rsvp: await updateRsvp(user.id, slug, id, body) }
})
