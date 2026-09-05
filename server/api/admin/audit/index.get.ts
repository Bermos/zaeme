import { z } from 'zod'
import { listAudit, summariseAudit } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'

/** The audit log, newest first, with its header counts. */
const querySchema = z.object({
  surface: z.enum(['admin', 'host', 'me', 'invite', 'machine']).optional(),
  actorKind: z.enum(['owner', 'planner', 'guest', 'service', 'anonymous']).optional(),
  eventSlug: z.string().max(200).optional(),
  failuresOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.iso.datetime({ offset: true }).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const query = await getValidatedQuery(e, querySchema.parse)
  const [entries, summary] = await Promise.all([
    listAudit({ ...query, before: query.before ? new Date(query.before) : undefined }),
    summariseAudit(7)
  ])
  return { entries, summary }
})
