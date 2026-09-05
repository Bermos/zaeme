import { z } from 'zod'
import { publishConcert } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'

/**
 * `publishConcert` — create or patch the public event that announces a concert.
 * Idempotent by `sourceId`, which zäme stores as the event's external ref; the
 * `eventId` Enterprise remembers is a hint only, so a stale one cannot mint a
 * duplicate announcement.
 */
const bodySchema = z.object({
  sourceId: z.string().min(1),
  eventId: z.string().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  location: z.string().max(500).nullable().optional(),
  ticketUrl: z.url().nullable().optional(),
  performerNote: z.string().max(1000).nullable().optional(),
  posterUrl: z.string().nullable().optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const body = bodySchema.parse(await readBody(event))
  return publishConcert(caller.planner.id, body)
})
