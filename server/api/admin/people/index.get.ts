import { z } from 'zod'
import { peopleDirectory } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'

/** Everybody this instance knows, keyed by the email that is the guest identity. */
const querySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { people: await peopleDirectory(await getValidatedQuery(e, querySchema.parse)) }
})
