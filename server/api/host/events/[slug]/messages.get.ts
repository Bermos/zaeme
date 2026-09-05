import { z } from 'zod'
import { listMessagesForPlanner } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** The event chat, host side; pass `afterId` when polling. */
const querySchema = z.object({ afterId: z.string().max(50).optional() })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const query = await getValidatedQuery(e, querySchema.parse)
  const messages = await listMessagesForPlanner(user.id, slug, { afterId: query.afterId ?? null })
  return { messages }
})
