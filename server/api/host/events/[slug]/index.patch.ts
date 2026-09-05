import { z } from 'zod'
import { updateEvent } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Edit the gathering's details (planner only). */
const bodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional().nullable(),
  posterUrl: z.string().url().max(1000).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }).optional().nullable(),
  endsAt: z.string().datetime({ offset: true }).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const event = await updateEvent(user.id, slug, body)
  return { event }
})
