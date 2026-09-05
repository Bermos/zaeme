import { revokeInvite } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { invite } from '../../../../../utils/v1-shapes'

/** `revokeInvite` — its holders see "no longer active". */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const inviteId = getRouterParam(event, 'inviteId')!
  return invite(await revokeInvite(caller.planner.id, slug, inviteId))
})
