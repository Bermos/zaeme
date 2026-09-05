import { z } from 'zod'
import { pruneAudit } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'

/**
 * Retention, by hand. There is no automatic expiry: on a personal instance the
 * log is small, and a policy that quietly deletes evidence is worse than a
 * button that says what it removed. This request is itself audited.
 */
const bodySchema = z.object({ olderThanDays: z.number().int().min(1).max(3650) })

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const { olderThanDays } = await readValidatedBody(e, bodySchema.parse)
  return { removed: await pruneAudit(olderThanDays) }
})
