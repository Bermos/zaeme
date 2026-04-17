import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { db } from './db'
import { requireAuth } from './session'
import { event, eventPlanner } from '#server/database/schema'

export type PlannerRole = 'owner' | 'co_planner' | 'logistics'

export interface EventRow {
  id: string
  slug: string
  title: string
  type: 'hosted' | 'concert' | 'series'
  status: 'draft' | 'polling' | 'published' | 'completed' | 'cancelled'
  description: string | null
  startsAt: Date | null
  endsAt: Date | null
  location: string | null
  venueStation: string | null
  ticketUrl: string | null
  performerNote: string | null
  isPublic: boolean
  parentId: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Load an event by slug or throw 404.
 */
export async function getEventBySlugOrThrow(slug: string): Promise<EventRow> {
  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }
  return row as EventRow
}

/**
 * Ensure the authenticated user is a planner on the given event. Optionally
 * restrict to a subset of planner roles (e.g. owner-only actions).
 *
 * Returns `{ session, eventRow, role }` for callers to use.
 */
export async function requirePlanner(
  e: H3Event,
  slug: string,
  opts: { allowedRoles?: PlannerRole[] } = {}
) {
  const session = await requireAuth(e)
  const eventRow = await getEventBySlugOrThrow(slug)

  const [plannerRow] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, eventRow.id),
      eq(eventPlanner.userId, session.user.id)
    ))
    .limit(1)

  if (!plannerRow) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const role = plannerRow.role as PlannerRole
  if (opts.allowedRoles && !opts.allowedRoles.includes(role)) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  return { session, eventRow, role }
}
