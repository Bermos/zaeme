import { desc, eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { requirePlanner } from '#server/utils/planner'
import { attendee } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  const { eventRow } = await requirePlanner(e, slug)

  if (e.method === 'GET') {
    return db
      .select({
        id: attendee.id,
        userId: attendee.userId,
        name: attendee.name,
        email: attendee.email,
        rsvpStatus: attendee.rsvpStatus,
        plusOne: attendee.plusOne,
        dietary: attendee.dietary,
        accessibility: attendee.accessibility,
        note: attendee.note,
        createdAt: attendee.createdAt,
        updatedAt: attendee.updatedAt
      })
      .from(attendee)
      .where(eq(attendee.eventId, eventRow.id))
      .orderBy(desc(attendee.createdAt))
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
