import { removeSeriesMember } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Remove a member from the series' standing group. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const members = await removeSeriesMember(user.id, slug, id)
  return { members }
})
