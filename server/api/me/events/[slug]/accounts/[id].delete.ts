import { removeAccountAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Remove a category account (#61).
 *
 * Two refusals, decided in the domain: an account that still holds lines is a
 * 409 — deleting it would orphan the money posted to it — and `Uncategorised`
 * and `Rounding` are refused outright, because every line needs a destination
 * and the conversion residual needs a home.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  return { accounts: await removeAccountAsParticipant(user, slug, id) }
})
