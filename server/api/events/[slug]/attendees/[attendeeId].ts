import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requirePlanner } from '#server/utils/planner'
import { attendee } from '#server/database/schema'

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  rsvpStatus: z.enum(['yes', 'maybe', 'no', 'cheering']).optional(),
  plusOne: z.number().int().min(0).max(1).optional(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  note: z.string().max(2000).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  const attendeeId = getRouterParam(e, 'attendeeId')!
  const { eventRow } = await requirePlanner(e, slug)

  const [row] = await db
    .select()
    .from(attendee)
    .where(and(
      eq(attendee.id, attendeeId),
      eq(attendee.eventId, eventRow.id)
    ))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Attendee not found' })
  }

  if (e.method === 'PATCH') {
    const body = await readValidatedBody(e, patchSchema.parse)

    // Keep rsvp_status consistent with event type: concerts use only
    // `cheering`, all other event types use yes/maybe/no.
    if (body.rsvpStatus !== undefined) {
      if (eventRow.type === 'concert' && body.rsvpStatus !== 'cheering') {
        throw createError({ statusCode: 422, message: 'Concert RSVPs use "cheering"' })
      }
      if (eventRow.type !== 'concert' && body.rsvpStatus === 'cheering') {
        throw createError({ statusCode: 422, message: '"cheering" is only valid for concerts' })
      }
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.rsvpStatus !== undefined) updates.rsvpStatus = body.rsvpStatus
    if (body.plusOne !== undefined) updates.plusOne = body.plusOne
    if (body.dietary !== undefined) updates.dietary = body.dietary
    if (body.accessibility !== undefined) updates.accessibility = body.accessibility
    if (body.note !== undefined) updates.note = body.note

    if (Object.keys(updates).length === 0) {
      return row
    }

    const [updated] = await db
      .update(attendee)
      .set(updates)
      .where(eq(attendee.id, row.id))
      .returning()
    return updated
  }

  if (e.method === 'DELETE') {
    await db.delete(attendee).where(eq(attendee.id, row.id))
    return { success: true }
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
