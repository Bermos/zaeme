import { z } from 'zod'
import { addDateOption } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Propose a date option for the availability poll (planner only). */
const bodySchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional().nullable(),
  note: z.string().max(300).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const option = await addDateOption(user.id, slug, body)
  return { option }
})
