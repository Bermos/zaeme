import { listInvites } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { invite } from '#server/utils/v1-shapes'

/** `listInvites` — the event's invite links with their usage and RSVP counts. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listInvites(caller.planner.id, slug)).map(invite)
})
