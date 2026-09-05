import { revokeInviteAsOwner } from '../../../../domain/index'
import { requireOwner } from '../../../../utils/admin'

/**
 * Close a link, from the instance side. Unlike the host route this does not ask
 * whether the owner plans that particular event — see `revokeInviteAsOwner`.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { invite: await revokeInviteAsOwner(getRouterParam(e, 'id')!) }
})
