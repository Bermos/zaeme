import { loadAccountsAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * The event's chart of accounts with what has been posted to each one (#61).
 *
 * This is where "what did accommodation cost" is answered — one grouped query
 * over one account, rather than a filter on a string column that used to live
 * on every expense row. The gate is the participant gate the budget uses, in
 * the domain; a handler never decides who is on an event.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  return { accounts: await loadAccountsAsParticipant(user, slug) }
})
