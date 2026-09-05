import { z } from 'zod'
import { postMessageAsPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { chatMessage } from '#server/utils/v1-shapes'

/**
 * `postEventChatMessage` — posts as the host.
 *
 * The author identity is zäme's own fact about its planner, resolved from the
 * service token's owner mapping. Enterprise no longer supplies a display name
 * (its `getOwnerIdentity` is gone with the split), and this route must not
 * accept one — a machine caller naming its own author is how a "host" message
 * stops being from the host.
 */
const bodySchema = z.object({ body: z.string().min(1).max(2000) }).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const message = await postMessageAsPlanner(caller.planner.id, slug, {
    body: body.body,
    authorName: caller.planner.name,
    authorEmail: caller.planner.email
  })
  setResponseStatus(event, 201)
  return chatMessage(message)
})
