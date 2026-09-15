import { deleteLegAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/** Remove a leg (owner/co-planner only). The places it joined stay. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  return deleteLegAsPlanner(user.id, slug, id)
})
