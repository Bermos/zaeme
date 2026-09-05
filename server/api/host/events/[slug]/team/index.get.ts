import { listPlannerTeam } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** The organizer team: planners + outstanding co-organizer invites. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const team = await listPlannerTeam(user.id, slug)
  return { ...team, me: user.id }
})
