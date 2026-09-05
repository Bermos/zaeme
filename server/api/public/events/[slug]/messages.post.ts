import { z } from 'zod'
import { getPublicEventPage, isPublicAttendee, postMessage } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Post to a public event's chat — signed-in attendees only. */
const bodySchema = z.object({ body: z.string().min(1).max(2000) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const { event } = await getPublicEventPage(slug)
  if (!await isPublicAttendee(event.id, user.email)) {
    throw createError({ statusCode: 403, message: 'Mark yourself as going first — then join the chat' })
  }
  const message = await postMessage(event.id, {
    body: body.body,
    authorName: user.name,
    authorEmail: user.email
  })
  return { message }
})
