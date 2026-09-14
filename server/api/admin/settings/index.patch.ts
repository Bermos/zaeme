import { z } from 'zod'
import { setInstanceBaseCurrency } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * Change what the instance settles up in (#25, D6). The owner's, and only the
 * owner's — every balance on the instance is denominated by this one value.
 *
 * The domain refuses the change (409) while expenses are recorded against a
 * different base; see `setInstanceBaseCurrency` for why that is the rule rather
 * than re-converting history.
 */
const bodySchema = z.object({
  baseCurrency: z.string().length(3)
}).strict()

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const body = await readValidatedBody(e, bodySchema.parse)
  return { settings: await setInstanceBaseCurrency(body.baseCurrency) }
})
