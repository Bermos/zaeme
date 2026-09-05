import { deleteAccount } from '../../../../domain/index'
import { requireOwner } from '../../../../utils/admin'
import { resolveInstanceOwnerId } from '../../../../utils/instance'

/**
 * Delete an account. The owner's own is refused in the domain — an instance is
 * defined by its first account, and deleting it would hand the instance to
 * whoever registered second.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return deleteAccount(getRouterParam(e, 'id')!, await resolveInstanceOwnerId())
})
