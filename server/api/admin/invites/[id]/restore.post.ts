import { restoreInviteAsOwner } from '../../../../domain/index'
import { requireOwner } from '../../../../utils/admin'

/** Undo a revocation — the mis-click's only remedy. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { invite: await restoreInviteAsOwner(getRouterParam(e, 'id')!) }
})
