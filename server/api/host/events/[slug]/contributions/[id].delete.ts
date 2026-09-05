import { deleteContribution } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Remove a bring-list item entirely (planner only). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  await deleteContribution(user.id, slug, id)
  return { ok: true }
})
