import { loadGeographyAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * The trip's map (#30): every place on this event and every leg between them,
 * in one read — the host card draws both lists from it.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  return loadGeographyAsPlanner(user.id, slug)
})
