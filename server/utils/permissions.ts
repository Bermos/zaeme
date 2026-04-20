import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { event, eventPlanner } from '#server/database/schema'

export type PlannerRole = 'owner' | 'co_planner' | 'logistics'

interface AssertPlannerOpts {
  /** If provided, only these roles pass the check. Default: any role. */
  roles?: readonly PlannerRole[]
}

export async function loadEventBySlug(slug: string) {
  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  return row
}

export async function assertPlanner(
  eventId: string,
  userId: string,
  opts: AssertPlannerOpts = {}
): Promise<PlannerRole> {
  const [row] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, eventId),
      eq(eventPlanner.userId, userId)
    ))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const role = row.role as PlannerRole
  if (opts.roles && !opts.roles.includes(role)) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  return role
}
