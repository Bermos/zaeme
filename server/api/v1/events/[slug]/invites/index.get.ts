import { listInvites } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { invite } from '../../../../../utils/v1-shapes'

/** `listInvites` — the event's invite links with their usage and RSVP counts. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listInvites(caller.planner.id, slug)).map(invite)
})
