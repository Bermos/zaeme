import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { addPlanner, assertPlanner, loadEventBySlug, type PlannerRole } from './permissions'

/**
 * The organizer team (ADR-0019 "collaborate on some events with others"): the
 * host shares a co-organizer capability link; another zäme account opens it,
 * signs in, and accepts — gaining a planner role on the event. Kept separate
 * from guest invites because the grant is a planning role, not attendance.
 */

export interface PlannerTeamView {
  planners: Array<{ userId: string, role: PlannerRole, isInstanceOwner: boolean }>
  pending: Array<{
    id: string
    token: string
    email: string | null
    role: PlannerRole
    revokedAt: Date | null
    createdAt: Date
  }>
}

/** The event's planners + outstanding co-organizer invites (planner only). */
export async function listPlannerTeam(userId: string, slug: string): Promise<PlannerTeamView> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  const db = useDb()

  const [planners, invites] = await Promise.all([
    db
      .select({ userId: tables.eventPlanner.userId, role: tables.eventPlanner.role })
      .from(tables.eventPlanner)
      .where(eq(tables.eventPlanner.eventId, ev.id))
      .orderBy(asc(tables.eventPlanner.createdAt)),
    db
      .select()
      .from(tables.plannerInvite)
      .where(and(eq(tables.plannerInvite.eventId, ev.id), isNull(tables.plannerInvite.acceptedAt)))
      .orderBy(desc(tables.plannerInvite.createdAt))
  ])

  return {
    planners: planners.map(p => ({ userId: p.userId, role: p.role as PlannerRole, isInstanceOwner: false })),
    pending: invites.map(i => ({
      id: i.id,
      token: i.token,
      email: i.email,
      role: i.role as PlannerRole,
      revokedAt: i.revokedAt,
      createdAt: i.createdAt
    }))
  }
}

/** Mint a co-organizer invite link (owner/co-planner only). */
export async function createPlannerInvite(
  userId: string,
  slug: string,
  input: { email?: string | null, role?: 'co_planner' | 'logistics' } = {}
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [inserted] = await useDb()
    .insert(tables.plannerInvite)
    .values({
      id: createId(),
      eventId: ev.id,
      token: createId(),
      email: input.email?.toLowerCase() ?? null,
      role: input.role ?? 'co_planner',
      createdByUserId: userId
    })
    .returning()
  return inserted!
}

/** Revoke an outstanding co-organizer invite (owner/co-planner only). */
export async function revokePlannerInvite(userId: string, slug: string, inviteId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .update(tables.plannerInvite)
    .set({ revokedAt: new Date() })
    .where(and(eq(tables.plannerInvite.id, inviteId), eq(tables.plannerInvite.eventId, ev.id)))
}

/**
 * Resolve a co-organizer token for the join page — the event it grants and
 * whether it is still live. Read-only; accepting is a separate, signed-in step.
 */
export async function resolvePlannerInvite(token: string) {
  const [row] = await useDb()
    .select({ invite: tables.plannerInvite, event: tables.event })
    .from(tables.plannerInvite)
    .innerJoin(tables.event, eq(tables.plannerInvite.eventId, tables.event.id))
    .where(eq(tables.plannerInvite.token, token))
    .limit(1)

  if (!row) throw createError({ statusCode: 404, message: 'Invite not found' })
  if (row.invite.revokedAt) throw createError({ statusCode: 410, message: 'This invite has been revoked' })
  if (row.invite.acceptedAt) throw createError({ statusCode: 410, message: 'This invite has already been used' })
  return row
}

/**
 * Accept a co-organizer invite as the signed-in zäme user: adds the planner
 * row and stamps the invite. An email-restricted invite only accepts the
 * matching account.
 */
export async function acceptPlannerInvite(token: string, user: { id: string, email: string }) {
  const { invite: inv, event: ev } = await resolvePlannerInvite(token)

  if (inv.email && inv.email !== user.email.toLowerCase()) {
    throw createError({ statusCode: 403, message: 'This invite is for a different email address' })
  }

  await addPlanner(ev.id, user.id, inv.role as PlannerRole)
  await useDb()
    .update(tables.plannerInvite)
    .set({ acceptedByUserId: user.id, acceptedAt: new Date() })
    .where(eq(tables.plannerInvite.id, inv.id))

  return { eventSlug: ev.slug, eventTitle: ev.title, role: inv.role as PlannerRole }
}

/** Remove a co-planner (owner only; the owner row itself is immovable). */
export async function removePlanner(userId: string, slug: string, plannerUserId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner'] })

  const [target] = await useDb()
    .select()
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, ev.id), eq(tables.eventPlanner.userId, plannerUserId)))
    .limit(1)
  if (!target) throw createError({ statusCode: 404, message: 'Planner not found' })
  if (target.role === 'owner') {
    throw createError({ statusCode: 422, message: 'The event owner cannot be removed' })
  }
  await useDb().delete(tables.eventPlanner).where(eq(tables.eventPlanner.id, target.id))
}
