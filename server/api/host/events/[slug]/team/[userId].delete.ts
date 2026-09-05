import { removePlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Remove a co-planner from the team (owner only; the owner is immovable). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const userId = getRouterParam(e, 'userId')!
  await removePlanner(user.id, slug, userId)
  return { removed: true }
})
