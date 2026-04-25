import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { dispatch } from '#server/inngest/client'
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
    status: z.enum(['draft', 'polling', 'published', 'completed', 'cancelled']),
    /** Optional reason attached to cancellation notifications. */
    reason: z.string().max(2000).optional().nullable()
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

  // Dispatch background notifications. `dispatch` swallows errors so a
  // misconfigured Inngest / mail provider does not block the transition.
  if (body.status === 'published') {
    await dispatch('event.published', { eventId: row.id })
  } else if (body.status === 'cancelled') {
    await dispatch('event.cancelled', { eventId: row.id, reason: body.reason ?? null })
  } else if (body.status === 'polling') {
    // Fan out "vote on a date" emails to every targeted invite. The job
    // skips quietly if no poll has been created yet — planners are free
    // to create the poll either before or after flipping to `polling`.
    await dispatch('datepoll.invite', { eventId: row.id })
  }

  return updated
})
