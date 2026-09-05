import { z } from 'zod'
import { guestListMessages } from '../../../domain/index'

/** Event chat via the invite link; pass `afterId` when polling for new ones. */
const querySchema = z.object({ afterId: z.string().max(50).optional() })

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const query = await getValidatedQuery(e, querySchema.parse)
  const messages = await guestListMessages(token, { afterId: query.afterId ?? null })
  return { messages }
})
