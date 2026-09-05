import { removeExpenseAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Remove an expense (owner/co-planner only). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  await removeExpenseAsPlanner(user.id, slug, id)
  return { removed: true }
})
