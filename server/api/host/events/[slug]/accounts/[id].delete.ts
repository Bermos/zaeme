import { removeAccountAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/**
 * Remove a category account (owner/co-planner only).
 *
 * The two refusals are the domain's: an account that still holds lines is a
 * 409, and `Uncategorised` and `Rounding` are refused outright.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  return { accounts: await removeAccountAsPlanner(user.id, slug, id) }
})
