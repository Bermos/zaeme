import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { attendee, event } from '#server/database/schema'

const patchSchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']).optional(),
  name: z.string().min(1).max(200).optional(),
  plusOne: z.number().int().min(0).max(1).optional(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  note: z.string().max(2000).optional().nullable()
})

/**
 * Magic-link-style self-service RSVP management. The `rsvpToken` is an
 * unguessable cuid2 that is given to the attendee (e.g. in a confirmation
 * email) and acts as a credential to view/update their own RSVP.
 */
export default defineEventHandler(async (e) => {
  const rsvpToken = getRouterParam(e, 'rsvpToken')!

  const [row] = await db
    .select({
      attendee: attendee,
      event: event
    })
    .from(attendee)
    .innerJoin(event, eq(attendee.eventId, event.id))
    .where(eq(attendee.rsvpToken, rsvpToken))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'RSVP not found' })
  }

  if (e.method === 'GET') {
    return {
      attendee: {
        id: row.attendee.id,
        name: row.attendee.name,
        email: row.attendee.email,
        rsvpStatus: row.attendee.rsvpStatus,
        plusOne: row.attendee.plusOne,
        dietary: row.attendee.dietary,
        accessibility: row.attendee.accessibility,
        note: row.attendee.note
      },
      event: {
        slug: row.event.slug,
        title: row.event.title,
        type: row.event.type,
        status: row.event.status,
        description: row.event.description,
        startsAt: row.event.startsAt,
        endsAt: row.event.endsAt,
        location: row.event.location,
        venueStation: row.event.venueStation,
        ticketUrl: row.event.ticketUrl,
        performerNote: row.event.performerNote
      }
    }
  }

  if (e.method === 'PATCH') {
    if (row.event.status !== 'polling' && row.event.status !== 'published') {
      throw createError({ statusCode: 422, message: 'Event is not open for RSVPs' })
    }
    const body = await readValidatedBody(e, patchSchema.parse)

    if (body.status) {
      if (row.event.type === 'concert' && body.status !== 'cheering') {
        throw createError({ statusCode: 422, message: 'Concert RSVPs use "cheering"' })
      }
      if (row.event.type !== 'concert' && body.status === 'cheering') {
        throw createError({ statusCode: 422, message: '"cheering" is only valid for concerts' })
      }
    }

    const updates: Record<string, unknown> = {}
    if (body.name !== undefined) updates.name = body.name
    if (body.status !== undefined) updates.rsvpStatus = body.status
    if (body.plusOne !== undefined) updates.plusOne = body.plusOne
    if (body.dietary !== undefined) updates.dietary = body.dietary
    if (body.accessibility !== undefined) updates.accessibility = body.accessibility
    if (body.note !== undefined) updates.note = body.note

    if (Object.keys(updates).length === 0) {
      return row.attendee
    }

    const [updated] = await db
      .update(attendee)
      .set(updates)
      .where(eq(attendee.id, row.attendee.id))
      .returning()
    return updated
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
