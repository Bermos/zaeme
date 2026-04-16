import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { event, eventPlanner } from '#server/database/schema'

// Valid status transitions
const TRANSITIONS: Record<string, string[]> = {
  draft: ['polling', 'published', 'cancelled'],
  polling: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
}

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

  // Only owner or co_planner can transition status
  const [plannerRow] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, row.id),
      eq(eventPlanner.userId, session.user.id)
    ))
    .limit(1)

  if (!plannerRow || plannerRow.role === 'logistics') {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const schema = z.object({
    status: z.enum(['draft', 'polling', 'published', 'completed', 'cancelled'])
  })

  const body = await readValidatedBody(e, schema.parse)

  const allowed = TRANSITIONS[row.status] ?? []
  if (!allowed.includes(body.status)) {
    throw createError({
      statusCode: 422,
      message: `Cannot transition from "${row.status}" to "${body.status}"`
    })
  }

  const [updated] = await db
    .update(event)
    .set({ status: body.status })
    .where(eq(event.id, row.id))
    .returning()

  return updated
})
