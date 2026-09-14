import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { guestUser } from '../database/schema/auth'

/**
 * Event access control. Extracted from `layers/events/server/utils/
 * permissions.ts` (originally zaeme). The owner/co-planner/logistics model is
 * unchanged; `userId` is whichever auth domain the calling app resolved — the
 * Enterprise owner's better-auth id, or a zäme account's id (ADR-0019 §3/§4).
 */

export type PlannerRole = 'owner' | 'co_planner' | 'logistics'

/**
 * How an ACCOUNT belongs to an event: as one of its planners, or as somebody
 * who was invited and answered. See `assertParticipant`.
 */
export type ParticipantRole = PlannerRole | 'participant'

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

/**
 * The account-scoped counterpart of `assertPlanner`: is this signed-in account
 * ON this event at all? A planner row passes, and so does an RSVP whose
 * `guestEmail` is the account's email — because in zäme a person IS their
 * lowercased email address (`server/domain/guest.ts`), and an account is the
 * same person having proved they hold that address. There is deliberately no
 * second identity model; matching the email is the whole of it.
 *
 * This exists because expense WRITES moved off the invite capability URL and
 * onto an account (#48): the link no longer buys the right to record money, but
 * a trip participant is not a planner either, so neither existing gate fits.
 * Reads over the invite link are untouched.
 */
export async function assertParticipant(eventId: string, userId: string): Promise<ParticipantRole> {
  const db = useDb()

  const [planner] = await db
    .select({ role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
    .limit(1)
  if (planner) return planner.role as PlannerRole

  const [account] = await db
    .select({ email: guestUser.email })
    .from(guestUser)
    .where(eq(guestUser.id, userId))
    .limit(1)

  if (account) {
    // RSVP emails are stored lowercased on write; lowercase this side too
    // rather than trusting the stored casing.
    const [rsvp] = await db
      .select({ id: tables.rsvp.id })
      .from(tables.rsvp)
      .where(and(eq(tables.rsvp.eventId, eventId), eq(tables.rsvp.guestEmail, account.email.toLowerCase())))
      .limit(1)
    if (rsvp) return 'participant'
  }

  throw createError({ statusCode: 403, message: 'You are not on this event — RSVP first, then you can add expenses' })
}
