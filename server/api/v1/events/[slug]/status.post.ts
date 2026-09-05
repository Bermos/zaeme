import { z } from 'zod'
import { loadEventBySlug, setEventStatus } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { asInvalidTransition } from '../../../../utils/api-v1'
import { dispatchEvent } from '../../../../utils/dispatch'
import { eventSummary } from '../../../../utils/v1-shapes'

/**
 * `setEventStatus` — the lifecycle move. Publishing sends invite emails and
 * cancelling notifies attendees, both through the injected dispatch.
 */
const bodySchema = z.object({
  status: z.enum(['draft', 'polling', 'published', 'completed', 'cancelled']),
  reason: z.string().max(2000).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  // Read the current status first so a refused transition can report `from`.
  const current = await loadEventBySlug(slug)
  const updated = await asInvalidTransition(
    () => setEventStatus(caller.planner.id, slug, body.status, body.reason, { dispatch: dispatchEvent }),
    { from: current.status, to: body.status }
  )
  return eventSummary(updated!)
})
