import { z } from 'zod'
import { listAllEvents } from '../../domain/index'
import { requireOwner } from '../../utils/admin'

/** Every event on the instance, filtered — the cross-event list. */
const querySchema = z.object({
  status: z.enum(['draft', 'polling', 'published', 'completed', 'cancelled']).optional(),
  type: z.enum(['hosted', 'concert', 'series', 'trip', 'party']).optional(),
  when: z.enum(['upcoming', 'past', 'undated']).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return listAllEvents(await getValidatedQuery(e, querySchema.parse))
})
