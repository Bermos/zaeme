import { z } from 'zod'
import { getPublicEventPage, isPublicAttendee, listMessages } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/**
 * The coordination chat on a public event — attendees only ("I go" first),
 * signed-in: this is where people who marked themselves going find each other.
 */
const querySchema = z.object({ afterId: z.string().max(50).optional() })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const query = await getValidatedQuery(e, querySchema.parse)

  const { event } = await getPublicEventPage(slug)
  if (!await isPublicAttendee(event.id, user.email)) {
    throw createError({ statusCode: 403, message: 'Mark yourself as going first — then join the chat' })
  }
  const messages = await listMessages(event.id, { afterId: query.afterId ?? null })
  return { messages }
})
