import { z } from 'zod'
import { addSeriesMember } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Add a friend to the series' standing group (idempotent by email). */
const bodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const members = await addSeriesMember(user.id, slug, body)
  return { members }
})
