import { z } from 'zod'
import { savePublicRsvp } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'
import { dispatchEvent } from '../../../../utils/dispatch'

/**
 * "I go" on a public event — signed-in zäme users only (no invite token exists
 * to act as the credential; the account IS the identity here, ADR-0019 §3).
 */
const bodySchema = z.object({ status: z.enum(['yes', 'maybe', 'no', 'cheering']) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const rsvp = await savePublicRsvp(
    slug,
    body.status,
    { userId: user.id, name: user.name, email: user.email },
    { dispatch: dispatchEvent }
  )
  return { rsvp }
})
