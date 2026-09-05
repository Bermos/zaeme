import { z } from 'zod'
import { addSeriesMemberOne } from '../../../../../../domain/index'
import { defineServiceHandler } from '../../../../../../utils/service-auth'
import { seriesMember } from '../../../../../../utils/v1-shapes'

/**
 * `addSeriesMember` — idempotent by email, so a repeat is a 200 with the same
 * row, never a 409.
 */
const bodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  return seriesMember(await addSeriesMemberOne(caller.planner.id, slug, body))
})
