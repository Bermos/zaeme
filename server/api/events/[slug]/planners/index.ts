import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { event, eventPlanner, user } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!

  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  // Only owner can manage planners
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

  if (e.method === 'GET') {
    return db
      .select({
        userId: eventPlanner.userId,
        role: eventPlanner.role,
        name: user.name,
        email: user.email
      })
      .from(eventPlanner)
      .innerJoin(user, eq(eventPlanner.userId, user.id))
      .where(eq(eventPlanner.eventId, row.id));
  }

  if (e.method === 'POST') {
    const schema = z.object({
      userId: z.string().min(1),
      role: z.enum(['co_planner', 'logistics']).default('co_planner')
    })

    const body = await readValidatedBody(e, schema.parse)

    // Check user exists
    const [targetUser] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, body.userId))
      .limit(1)

    if (!targetUser) {
      throw createError({ statusCode: 404, message: 'User not found' })
    }

    // Check not already a planner
    const [existing] = await db
      .select({ id: eventPlanner.id })
      .from(eventPlanner)
      .where(and(
        eq(eventPlanner.eventId, row.id),
        eq(eventPlanner.userId, body.userId)
      ))
      .limit(1)

    if (existing) {
      throw createError({ statusCode: 409, message: 'User is already a planner' })
    }

    const [inserted] = await db
      .insert(eventPlanner)
      .values({
        id: createId(),
        eventId: row.id,
        userId: body.userId,
        role: body.role
      })
      .returning()

    return inserted
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
