import { z } from 'zod'
import { updateEvent } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { eventSummary } from '#server/utils/v1-shapes'

/** `updateEvent` — only the fields passed are changed; an explicit null clears one. */
const bodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  venueStation: z.string().max(200).nullable().optional(),
  ticketUrl: z.url().nullable().optional(),
  performerNote: z.string().max(1000).nullable().optional(),
  isPublic: z.boolean().optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const updated = await updateEvent(caller.planner.id, slug, body)
  return eventSummary(updated!)
})
