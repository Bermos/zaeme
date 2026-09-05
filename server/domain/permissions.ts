import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'

/**
 * Event access control. Extracted from `layers/events/server/utils/
 * permissions.ts` (originally zaeme). The owner/co-planner/logistics model is
 * unchanged; `userId` is whichever auth domain the calling app resolved — the
 * Enterprise owner's better-auth id, or a zäme account's id (ADR-0019 §3/§4).
 */

export type PlannerRole = 'owner' | 'co_planner' | 'logistics'

interface AssertPlannerOpts {
  /** If provided, only these roles pass the check. Default: any role. */
  roles?: readonly PlannerRole[]
}

export async function loadEventBySlug(slug: string) {
  const [row] = await useDb().select().from(tables.event).where(eq(tables.event.slug, slug)).limit(1)
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
  const [row] = await useDb()
    .select({ role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
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

/**
 * Add a planner to an event, idempotently (no-op if the user already has a
 * planner row). Used by zäme's create flow to attach the instance owner as a
 * co-planner alongside the zäme host (ADR-0019 §4: the owner sees everything).
 */
export async function addPlanner(eventId: string, userId: string, role: PlannerRole = 'co_planner'): Promise<void> {
  const db = useDb()
  const [existing] = await db
    .select({ id: tables.eventPlanner.id })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
    .limit(1)
  if (existing) return
  await db.insert(tables.eventPlanner).values({ id: createId(), eventId, userId, role })
}
