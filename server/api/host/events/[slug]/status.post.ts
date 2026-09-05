import { z } from 'zod'
import { setEventStatus } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'
import { dispatchEvent } from '../../../../utils/dispatch'

/** Lifecycle transition (start polling / publish / cancel / complete). */
const bodySchema = z.object({
  status: z.enum(['polling', 'published', 'completed', 'cancelled']),
  reason: z.string().max(500).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const event = await setEventStatus(user.id, slug, body.status, body.reason, { dispatch: dispatchEvent })
  return { event }
})
