import { revokeInvite } from '../../../../../../domain/index'
import { requireGuestUser } from '../../../../../../utils/auth'

/** Revoke an invite link (planner only) — its holders get a friendly 410. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const invite = await revokeInvite(user.id, slug, id)
  return { invite }
})
