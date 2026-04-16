import { eq, and } from 'drizzle-orm'
import { db } from '../../../../../utils/db'
import { requireAuth } from '../../../../../utils/session'
import { event, eventPlanner } from '../../../../../database/schema/events'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const userId = getRouterParam(e, 'userId')!

  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  // Only owner can remove planners
  const [plannerRow] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, row.id),
      eq(eventPlanner.userId, session.user.id)
    ))
    .limit(1)

  if (!plannerRow || plannerRow.role !== 'owner') {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  // Cannot remove owner
  const [targetPlanner] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, row.id),
      eq(eventPlanner.userId, userId)
    ))
    .limit(1)

  if (!targetPlanner) {
    throw createError({ statusCode: 404, message: 'Planner not found' })
  }

  if (targetPlanner.role === 'owner') {
    throw createError({ statusCode: 422, message: 'Cannot remove the event owner' })
  }

  await db
    .delete(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, row.id),
      eq(eventPlanner.userId, userId)
    ))

  return { success: true }
})
