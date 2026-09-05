import { z } from 'zod'
import { loadEventBySlug, lockDate } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { asInvalidTransition } from '#server/utils/api-v1'
import { dispatchEvent } from '#server/utils/dispatch'
import { eventSummary } from '#server/utils/v1-shapes'

/** `lockEventDate` — stamps the winning date and publishes, which sends the invites. */
const bodySchema = z.object({ optionId: z.string().min(1) }).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const current = await loadEventBySlug(slug)
  const updated = await asInvalidTransition(
    () => lockDate(caller.planner.id, slug, body.optionId, { dispatch: dispatchEvent }),
    { from: current.status, to: 'published' }
  )
  return eventSummary(updated!)
})
