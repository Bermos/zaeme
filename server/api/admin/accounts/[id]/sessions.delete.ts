import { revokeSessions } from '../../../../domain/index'
import { requireOwner } from '../../../../utils/admin'

/** Sign an account out everywhere — including, deliberately, the owner's own. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { revoked: await revokeSessions(getRouterParam(e, 'id')!) }
})
