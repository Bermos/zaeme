import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../../utils/db'
import { requireAuth } from '../../../utils/session'
import { event, eventPlanner } from '../../../database/schema/events'
import { user } from '../../../database/schema/auth'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const method = getMethod(e)

  // Load event
  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  // Check planner access
  const [plannerRow] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, row.id),
      eq(eventPlanner.userId, session.user.id)
    ))
    .limit(1)

  if (!plannerRow) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  if (method === 'GET') {
    // Include planners list
    const planners = await db
      .select({
        userId: eventPlanner.userId,
        role: eventPlanner.role,
        name: user.name,
        email: user.email
      })
      .from(eventPlanner)
      .innerJoin(user, eq(eventPlanner.userId, user.id))
      .where(eq(eventPlanner.eventId, row.id))

    return { ...row, planners }
  }

  if (method === 'PATCH') {
    const schema = z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().optional().nullable(),
      startsAt: z.string().datetime({ offset: true }).optional().nullable(),
      endsAt: z.string().datetime({ offset: true }).optional().nullable(),
      location: z.string().optional().nullable(),
      venueStation: z.string().optional().nullable(),
      ticketUrl: z.string().url().optional().nullable(),
      performerNote: z.string().optional().nullable(),
      isPublic: z.boolean().optional()
    })

    const body = await readValidatedBody(e, schema.parse)

    const updates: Record<string, unknown> = {}
    if (body.title !== undefined) updates.title = body.title
    if (body.description !== undefined) updates.description = body.description
    if (body.startsAt !== undefined) updates.startsAt = body.startsAt ? new Date(body.startsAt) : null
    if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? new Date(body.endsAt) : null
    if (body.location !== undefined) updates.location = body.location
    if (body.venueStation !== undefined) updates.venueStation = body.venueStation
    if (body.ticketUrl !== undefined) updates.ticketUrl = body.ticketUrl
    if (body.performerNote !== undefined) updates.performerNote = body.performerNote
    if (body.isPublic !== undefined) updates.isPublic = body.isPublic

    if (Object.keys(updates).length === 0) {
      return row
    }

    const [updated] = await db
      .update(event)
      .set(updates)
      .where(eq(event.id, row.id))
      .returning()

    return updated
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
