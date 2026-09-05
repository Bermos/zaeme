import { z } from 'zod'
import { createEvent } from '../../../domain/index'
import { defineServiceHandler } from '../../../utils/service-auth'

/** `createEvent` — a new event, starting as a draft. */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['hosted', 'concert', 'series', 'trip', 'party']).optional(),
  description: z.string().max(5000).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  location: z.string().max(500).optional(),
  venueStation: z.string().max(200).optional(),
  ticketUrl: z.string().url().optional(),
  performerNote: z.string().max(1000).optional(),
  cadence: z.string().max(200).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const body = bodySchema.parse(await readBody(event))
  const created = await createEvent(caller.planner.id, body)
  setResponseStatus(event, 201)
  return created
})
