import { z } from 'zod'
import { unpublishConcert } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'

/**
 * `unpublishConcert` — the announcement stops being public, so it leaves the
 * listing and its poster stops resolving. Idempotent; the Music history is
 * untouched.
 */
const bodySchema = z.object({ sourceId: z.string().min(1) }).strict()

export default defineServiceHandler(async (event, _caller) => {
  const body = bodySchema.parse(await readBody(event))
  return unpublishConcert(body.sourceId)
})
