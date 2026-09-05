import { deleteRsvp } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Remove an RSVP (planner only) — a duplicate, or somebody who dropped out. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  await deleteRsvp(user.id, slug, id)
  return { removed: true }
})
