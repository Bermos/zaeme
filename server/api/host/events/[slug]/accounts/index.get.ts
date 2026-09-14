import { loadAccountsAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** The event's chart of accounts with what has been posted to each (#61). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  return { accounts: await loadAccountsAsPlanner(user.id, slug) }
})
