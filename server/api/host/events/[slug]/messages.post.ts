import { z } from 'zod'
import { postMessageAsPlanner } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Post to the event chat as the host (badged in the thread). */
const bodySchema = z.object({ body: z.string().min(1).max(2000) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const message = await postMessageAsPlanner(user.id, slug, {
    body: body.body,
    authorName: user.name,
    authorEmail: user.email
  })
  return { message }
})
