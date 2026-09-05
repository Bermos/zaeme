import { listMediaForPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'
import { signMediaItems } from '../../../../../utils/media-sign'

/** Everything the host manages — gallery, documents, tickets — with signed URLs. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const items = await listMediaForPlanner(user.id, slug)
  return { media: await signMediaItems(items) }
})
