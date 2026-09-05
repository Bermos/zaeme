import { z } from 'zod'
import { updateRsvp } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { rsvp } from '#server/utils/v1-shapes'

/** `updateRsvp` — one attendee's answer, +1 and notes. */
const bodySchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']).optional(),
  plusOne: z.boolean().optional(),
  plusOneName: z.string().max(200).nullable().optional(),
  dietary: z.string().max(500).nullable().optional(),
  accessibility: z.string().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const rsvpId = getRouterParam(event, 'rsvpId')!
  const body = bodySchema.parse(await readBody(event))
  return rsvp(await updateRsvp(caller.planner.id, slug, rsvpId, body))
})
