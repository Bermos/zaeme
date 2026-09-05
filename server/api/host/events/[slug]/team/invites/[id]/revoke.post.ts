import { revokePlannerInvite } from '../../../../../../../domain/index'
import { requireGuestUser } from '../../../../../../../utils/auth'

/** Revoke an outstanding co-organizer invite. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  await revokePlannerInvite(user.id, slug, id)
  return { revoked: true }
})
