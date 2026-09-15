import { deletePlaceAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Remove a place (owner/co-planner only), and say what that did to what
 * pointed at it: `detachedLegs`, `removedLegs` and `detachedItems` come back
 * beside the new map so the screen can report it rather than the planner
 * discovering it later. The rule itself is in `deletePlaceAsPlanner`.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  return deletePlaceAsPlanner(user.id, slug, id)
})
