import { z } from 'zod'
import { setInstanceBaseCurrency } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * Change the currency a NEW trip starts in (#25 D6, narrowed by #59). The
 * owner's, and only the owner's.
 *
 * It is no longer refused by anything: every balance hangs off the event's own
 * currency, so this value labels no history and changing it moves no money. A
 * trip that wants to settle in something else changes it on its own page —
 * `PATCH /api/host/events/{slug}/currency` — where the confirmation and the
 * recompute live.
 */
const bodySchema = z.object({
  baseCurrency: z.string().length(3)
}).strict()

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const body = await readValidatedBody(e, bodySchema.parse)
  return { settings: await setInstanceBaseCurrency(body.baseCurrency) }
})
