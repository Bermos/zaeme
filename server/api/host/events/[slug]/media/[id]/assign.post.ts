import { z } from 'zod'
import { assignTicket } from '../../../../../../domain/index'
import { requireGuestUser } from '../../../../../../utils/auth'

/** Assign a ticket to an attendee's RSVP — or unassign with rsvpId null. */
const bodySchema = z.object({ rsvpId: z.string().min(1).max(50).nullable() })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await assignTicket(user.id, slug, id, body.rsvpId)
  return { media }
})
