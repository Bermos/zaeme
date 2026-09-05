import { listEvents } from '../../../domain/index'
import { requireGuestUser } from '../../../utils/auth'

/** Events the signed-in zäme user plans. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  return { events: await listEvents(user.id) }
})
