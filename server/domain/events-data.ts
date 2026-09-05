import { and, desc, eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { guestUser } from '../database/schema/auth'
import { assertPlanner, loadEventBySlug } from './permissions'
import { generateUniqueSlug } from './slugify'

/**
 * The events domain logic — the read/write operations over the `events_*`
 * tables. Extracted from `layers/events/server/utils/events-data.ts`
 * (originally consolidated from zaeme's `server/api/{events,invites,media}`
 * handlers) so the Enterprise shell's HTTP handlers + AI tool set AND the zäme
 * app's routes all call ONE implementation (ADR-0019 §5).
 *
 * Every function is user-scoped: `userId` is the acting planner, and writes go
 * through `assertPlanner` exactly as before. The one seam change from the layer
 * version: proactive dispatch is INJECTED (`EventDispatch`) rather than
 * imported from the orchestrator, so this package carries no Inngest/agent
 * dependency — each app supplies its own client (the layer keeps its
 * `dispatchEvent`; zäme brings a lightweight one).
 */

type DateInput = string | Date | null | undefined

export function toDate(v: DateInput): Date | null {
  if (!v) return null
  return v instanceof Date ? v : new Date(v)
}

/** Fire-and-forget proactive dispatch, supplied by the calling app. */
export type EventDispatch = (name: string, data: Record<string, unknown>) => Promise<void>

/* ------------------------------ pure helpers ------------------------------ */

/** Valid event status transitions (zaeme `status.post.ts`). */
export const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['polling', 'published', 'cancelled'],
  polling: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: []
}

export function canTransition(from: string, to: string): boolean {
  return (STATUS_TRANSITIONS[from] ?? []).includes(to)
}

export type RsvpStatus = 'yes' | 'maybe' | 'no' | 'cheering'

export interface RsvpSummary {
  yes: number
  maybe: number
  no: number
  cheering: number
  total: number
  /** Attending heads, counting +1s on yes/cheering. */
  headcount: number
}

/** Summarise RSVP rows into per-status counts + headcount (zaeme rsvps/index). */
export function summariseRsvps(rows: Array<{ status: string, plusOne?: boolean | null }>): RsvpSummary {
  const summary: RsvpSummary = { yes: 0, maybe: 0, no: 0, cheering: 0, total: rows.length, headcount: 0 }
  for (const r of rows) {
    summary[r.status as RsvpStatus] += 1
    if (r.status === 'yes' || r.status === 'cheering') {
      summary.headcount += 1 + (r.plusOne ? 1 : 0)
    }
  }
  return summary
}

/* -------------------------------- reads ---------------------------------- */

/** Events where the user is a planner, newest first. */
export function listEvents(userId: string) {
  return useDb()
    .select({
      id: tables.event.id,
      slug: tables.event.slug,
      title: tables.event.title,
      type: tables.event.type,
      status: tables.event.status,
      startsAt: tables.event.startsAt,
      endsAt: tables.event.endsAt,
      location: tables.event.location,
      isPublic: tables.event.isPublic,
      parentId: tables.event.parentId,
      createdAt: tables.event.createdAt,
      updatedAt: tables.event.updatedAt,
      plannerRole: tables.eventPlanner.role
    })
    .from(tables.event)
    .innerJoin(tables.eventPlanner, eq(tables.event.id, tables.eventPlanner.eventId))
    .where(eq(tables.eventPlanner.userId, userId))
    .orderBy(desc(tables.event.createdAt))
}

/** One event (with its planners) for a planner of it. */
export async function getEventForPlanner(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  const planners = await useDb()
    .select({ userId: tables.eventPlanner.userId, role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .where(eq(tables.eventPlanner.eventId, ev.id))
  return { ...ev, planners }
}

/** RSVP rows + summary for a planner of the event. */
export async function listRsvps(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  const rows = await useDb()
    .select({
      id: tables.rsvp.id,
      status: tables.rsvp.status,
      plusOne: tables.rsvp.plusOne,
      plusOneName: tables.rsvp.plusOneName,
      dietary: tables.rsvp.dietary,
      accessibility: tables.rsvp.accessibility,
      notes: tables.rsvp.notes,
      guestName: tables.rsvp.guestName,
      guestEmail: tables.rsvp.guestEmail,
      userId: tables.rsvp.userId,
      inviteId: tables.rsvp.inviteId,
      inviteLabel: tables.invite.label,
      createdAt: tables.rsvp.createdAt
    })
    .from(tables.rsvp)
    .leftJoin(tables.invite, eq(tables.rsvp.inviteId, tables.invite.id))
    .where(eq(tables.rsvp.eventId, ev.id))
    .orderBy(desc(tables.rsvp.createdAt))
  return { rsvps: rows, summary: summariseRsvps(rows) }
}

/** Invites for a planner of the event, with per-invite RSVP counts. */
export async function listInvites(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return useDb()
    .select({
      id: tables.invite.id,
      token: tables.invite.token,
      label: tables.invite.label,
      email: tables.invite.email,
      name: tables.invite.name,
      maxUses: tables.invite.maxUses,
      usedCount: tables.invite.usedCount,
      tier: tables.invite.tier,
      expiresAt: tables.invite.expiresAt,
      revokedAt: tables.invite.revokedAt,
      createdAt: tables.invite.createdAt,
      rsvpCount: sql<number>`(select count(*)::int from ${tables.rsvp} where ${tables.rsvp.inviteId} = ${tables.invite.id})`
    })
    .from(tables.invite)
    .where(eq(tables.invite.eventId, ev.id))
    .orderBy(desc(tables.invite.createdAt))
}

/** Itinerary items for a planner of the event, in display order. */
export async function listTimeline(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return useDb()
    .select()
    .from(tables.timelineItem)
    .where(eq(tables.timelineItem.eventId, ev.id))
    .orderBy(tables.timelineItem.sortOrder, tables.timelineItem.startsAt, tables.timelineItem.createdAt)
}

/** Ready media metadata for a planner of the event (no presigned URLs). */
export async function listMedia(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return useDb()
    .select({
      id: tables.media.id,
      type: tables.media.type,
      fileName: tables.media.fileName,
      caption: tables.media.caption,
      takenAt: tables.media.takenAt,
      assignedRsvpId: tables.media.assignedRsvpId,
      timelineItemId: tables.media.timelineItemId,
      createdAt: tables.media.createdAt
    })
    .from(tables.media)
    .where(and(eq(tables.media.eventId, ev.id), eq(tables.media.status, 'ready')))
    .orderBy(desc(tables.media.createdAt))
}

/* -------------------------------- writes --------------------------------- */

export interface CreateEventInput {
  title: string
  type?: 'hosted' | 'concert' | 'series' | 'trip' | 'party'
  description?: string | null
  posterUrl?: string | null
  startsAt?: DateInput
  endsAt?: DateInput
  location?: string | null
  venueStation?: string | null
  ticketUrl?: string | null
  performerNote?: string | null
  parentId?: string | null
  /** Series cadence note, e.g. "every second Friday". */
  cadence?: string | null
}

/** Create an event and make the caller its owner planner (zaeme events/index). */
export async function createEvent(userId: string, input: CreateEventInput): Promise<{ id: string, slug: string }> {
  const type = input.type ?? 'hosted'
  const id = createId()
  const slug = await generateUniqueSlug(input.title)
  const db = useDb()

  await db.transaction(async (tx) => {
    await tx.insert(tables.event).values({
      id,
      slug,
      title: input.title,
      type,
      status: 'draft',
      description: input.description ?? null,
      posterUrl: input.posterUrl ?? null,
      startsAt: toDate(input.startsAt),
      endsAt: toDate(input.endsAt),
      location: input.location ?? null,
      venueStation: input.venueStation ?? null,
      ticketUrl: input.ticketUrl ?? null,
      performerNote: input.performerNote ?? null,
      // Concert events are public by default (zaeme).
      isPublic: type === 'concert',
      parentId: input.parentId ?? null,
      cadence: input.cadence ?? null
    })
    await tx.insert(tables.eventPlanner).values({ id: createId(), eventId: id, userId, role: 'owner' })
  })

  return { id, slug }
}

export interface UpdateEventInput {
  title?: string
  description?: string | null
  posterUrl?: string | null
  startsAt?: DateInput
  endsAt?: DateInput
  location?: string | null
  venueStation?: string | null
  ticketUrl?: string | null
  performerNote?: string | null
  isPublic?: boolean
  cadence?: string | null
}

/** Patch an event (planner only). */
export async function updateEvent(userId: string, slug: string, input: UpdateEventInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)

  const updates: Record<string, unknown> = {}
  if (input.title !== undefined) updates.title = input.title
  if (input.description !== undefined) updates.description = input.description
  if (input.posterUrl !== undefined) updates.posterUrl = input.posterUrl
  if (input.startsAt !== undefined) updates.startsAt = toDate(input.startsAt)
  if (input.endsAt !== undefined) updates.endsAt = toDate(input.endsAt)
  if (input.location !== undefined) updates.location = input.location
  if (input.venueStation !== undefined) updates.venueStation = input.venueStation
  if (input.ticketUrl !== undefined) updates.ticketUrl = input.ticketUrl
  if (input.performerNote !== undefined) updates.performerNote = input.performerNote
  if (input.isPublic !== undefined) updates.isPublic = input.isPublic
  if (input.cadence !== undefined) updates.cadence = input.cadence
  if (Object.keys(updates).length === 0) return ev

  const [updated] = await useDb().update(tables.event).set(updates).where(eq(tables.event.id, ev.id)).returning()
  return updated
}

/**
 * Transition an event's lifecycle status (owner/co-planner only) and fire the
 * matching proactive job (invites on publish, cancellation notices on cancel)
 * through the caller's dispatch.
 */
export async function setEventStatus(
  userId: string,
  slug: string,
  status: string,
  reason?: string | null,
  opts: { dispatch?: EventDispatch } = {}
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  if (!canTransition(ev.status, status)) {
    throw createError({ statusCode: 422, message: `Cannot transition from "${ev.status}" to "${status}"` })
  }

  const [updated] = await useDb()
    .update(tables.event)
    .set({ status: status as typeof tables.event.$inferInsert.status })
    .where(eq(tables.event.id, ev.id))
    .returning()

  if (opts.dispatch) {
    if (status === 'published') {
      await opts.dispatch('events/event.published', { eventId: ev.id })
    } else if (status === 'cancelled') {
      await opts.dispatch('events/event.cancelled', { eventId: ev.id, reason: reason ?? null })
    }
  }

  return updated
}

export interface CreateInviteInput {
  label?: string | null
  email?: string | null
  name?: string | null
  maxUses?: number | null
  expiresAt?: DateInput
  /** Party phasing: `core` = the date-fixing group, `general` = the open wave. */
  tier?: 'core' | 'general'
}

/** Create an invite (owner/co-planner only). */
export async function createInvite(userId: string, slug: string, input: CreateInviteInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [inserted] = await useDb()
    .insert(tables.invite)
    .values({
      id: createId(),
      eventId: ev.id,
      token: createId(),
      label: input.label ?? null,
      email: input.email ?? null,
      name: input.name ?? null,
      maxUses: input.maxUses ?? null,
      expiresAt: toDate(input.expiresAt),
      tier: input.tier ?? 'general',
      createdByUserId: userId
    })
    .returning()
  return inserted
}

/** Revoke an invite link (owner/co-planner only) — its holders get a 410. */
export async function revokeInvite(userId: string, slug: string, inviteId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  const [updated] = await useDb()
    .update(tables.invite)
    .set({ revokedAt: new Date() })
    .where(and(eq(tables.invite.id, inviteId), eq(tables.invite.eventId, ev.id)))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Invite not found' })
  return updated
}

export interface UpdateRsvpInput {
  status?: RsvpStatus
  plusOne?: boolean
  plusOneName?: string | null
  dietary?: string | null
  accessibility?: string | null
  notes?: string | null
  guestName?: string | null
  guestEmail?: string | null
}

/** Update an RSVP (owner/co-planner only). */
export async function updateRsvp(userId: string, slug: string, rsvpId: string, input: UpdateRsvpInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const updates: Record<string, unknown> = {}
  for (const key of ['status', 'plusOne', 'plusOneName', 'dietary', 'accessibility', 'notes', 'guestName', 'guestEmail'] as const) {
    if (input[key] !== undefined) updates[key] = input[key]
  }
  const [updated] = await useDb()
    .update(tables.rsvp)
    .set(updates)
    .where(and(eq(tables.rsvp.id, rsvpId), eq(tables.rsvp.eventId, ev.id)))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'RSVP not found' })
  return updated
}

/** Delete an RSVP (owner/co-planner only). */
export async function deleteRsvp(userId: string, slug: string, rsvpId: string): Promise<void> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb().delete(tables.rsvp).where(and(eq(tables.rsvp.id, rsvpId), eq(tables.rsvp.eventId, ev.id)))
}

export interface CreateTimelineItemInput {
  title: string
  description?: string | null
  startsAt?: DateInput
  endsAt?: DateInput
  location?: string | null
  type?: 'transport' | 'activity' | 'accommodation' | 'meal' | 'other'
  icon?: string | null
  sortOrder?: number
}

/** Append an itinerary item (owner/co-planner only). */
export async function addTimelineItem(userId: string, slug: string, input: CreateTimelineItemInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  let sortOrder = input.sortOrder ?? 0
  if (input.sortOrder === undefined) {
    const existing = await useDb()
      .select({ sortOrder: tables.timelineItem.sortOrder })
      .from(tables.timelineItem)
      .where(eq(tables.timelineItem.eventId, ev.id))
      .orderBy(tables.timelineItem.sortOrder)
    const last = existing[existing.length - 1]
    if (last) sortOrder = (last.sortOrder ?? 0) + 10
  }

  const [inserted] = await useDb()
    .insert(tables.timelineItem)
    .values({
      id: createId(),
      eventId: ev.id,
      title: input.title,
      description: input.description ?? null,
      startsAt: toDate(input.startsAt),
      endsAt: toDate(input.endsAt),
      location: input.location ?? null,
      type: input.type ?? 'other',
      icon: input.icon ?? null,
      sortOrder
    })
    .returning()
  return inserted
}

export interface UpdateTimelineItemInput {
  title?: string
  description?: string | null
  startsAt?: DateInput
  endsAt?: DateInput
  location?: string | null
  type?: 'transport' | 'activity' | 'accommodation' | 'meal' | 'other'
  icon?: string | null
  sortOrder?: number
}

/**
 * Correct an itinerary item in place (owner/co-planner only).
 *
 * This existed in zäme before the 2026-07 absorption into the Enterprise
 * monorepo and did not survive the trip (issue #8): the host surface could
 * create and destroy an item but not fix a typo in one, and deleting to re-add
 * loses its place in the order. `sortOrder` is patchable for the same reason —
 * it is how an item moves without being rebuilt.
 *
 * Deliberately NOT exposed on `/api/v1`: the XO has no `updateTimelineItem`
 * tool, and minting one as a side effect of restoring a host handler would hand
 * the model a verb nobody decided to give it.
 */
export async function updateTimelineItem(
  userId: string,
  slug: string,
  itemId: string,
  input: UpdateTimelineItemInput
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const updates: Record<string, unknown> = {}
  if (input.title !== undefined) updates.title = input.title
  if (input.description !== undefined) updates.description = input.description
  if (input.startsAt !== undefined) updates.startsAt = toDate(input.startsAt)
  if (input.endsAt !== undefined) updates.endsAt = toDate(input.endsAt)
  if (input.location !== undefined) updates.location = input.location
  if (input.type !== undefined) updates.type = input.type
  if (input.icon !== undefined) updates.icon = input.icon
  if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder

  const db = useDb()
  if (Object.keys(updates).length === 0) {
    const [row] = await db
      .select()
      .from(tables.timelineItem)
      .where(and(eq(tables.timelineItem.id, itemId), eq(tables.timelineItem.eventId, ev.id)))
      .limit(1)
    if (!row) throw createError({ statusCode: 404, message: 'Timeline item not found' })
    return row
  }

  const [updated] = await db
    .update(tables.timelineItem)
    .set(updates)
    .where(and(eq(tables.timelineItem.id, itemId), eq(tables.timelineItem.eventId, ev.id)))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Timeline item not found' })
  return updated
}

/** Remove an itinerary item (owner/co-planner only). */
export async function deleteTimelineItem(userId: string, slug: string, itemId: string): Promise<void> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .delete(tables.timelineItem)
    .where(and(eq(tables.timelineItem.id, itemId), eq(tables.timelineItem.eventId, ev.id)))
}

/**
 * One event with its planning team resolved to people — the contract's
 * `EventDetail`. `getEventForPlanner` above answers ids and roles, which is all
 * the host UI needs; the machine API promises a name and an email per planner,
 * so the join lives here rather than in the route handler.
 */
export async function getEventDetailForPlanner(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  const plannerRole = await assertPlanner(ev.id, userId)
  const planners = await useDb()
    .select({
      userId: tables.eventPlanner.userId,
      role: tables.eventPlanner.role,
      name: guestUser.name,
      email: guestUser.email
    })
    .from(tables.eventPlanner)
    .leftJoin(guestUser, eq(tables.eventPlanner.userId, guestUser.id))
    .where(eq(tables.eventPlanner.eventId, ev.id))
  return { ...ev, plannerRole, planners }
}

/** An event's own row plus the caller's role on it — the `EventSummary` source. */
export async function getEventSummaryForPlanner(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  const plannerRole = await assertPlanner(ev.id, userId)
  return { ...ev, plannerRole }
}
