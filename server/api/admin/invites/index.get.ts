import { z } from 'zod'
import { listAllInvites } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'

/** Every capability link that exists, and what state it is in. */
const querySchema = z.object({
  state: z.enum(['active', 'revoked', 'expired']).optional(),
  eventSlug: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { invites: await listAllInvites(await getValidatedQuery(e, querySchema.parse)) }
})
