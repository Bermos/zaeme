import { acceptPlannerInvite } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Accept a co-organizer invite as the signed-in zäme user. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const token = getRouterParam(e, 'token')!
  return acceptPlannerInvite(token, { id: user.id, email: user.email })
})
