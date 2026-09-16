import { and, desc, eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { guestUser } from '../database/schema/auth'
import { assertPlaceOnEvent, assertPlanner, loadEventBySlug } from './permissions'
import { generateUniqueSlug } from './slugify'
import { instanceBaseCurrency } from './instance-settings'
import { TIMEZONE_REFUSAL, canonicalTimezone, isBlankTimezone } from '../../shared/utils/timezone'

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

/**
 * THE REFUSAL SIDE OF #31's display zone. The rule itself is
 * `shared/utils/timezone.ts` — one implementation, applied by the host form,
 * this domain and the tests — and it answers null for anything that is not a
 * named region zone. This is where a null becomes a 422.
 *
 * Blank, whitespace and an explicit null all mean "NO ZONE", which is a value
 * and not a mistake: it is what every event had before this column and what a
 * host clearing the field is asking for. So they resolve to null without a
 * refusal, and only a non-empty string that is not a zone is refused.
 *
 * 422 rather than 400 on purpose: the zod schemas on the routes bound the
 * length and nothing else, so a request that reaches here was well-formed and
 * was understood — what failed is the domain rule, and the message names what a
 * zone looks like rather than what this one is not.
 */
function resolveDisplayTimezone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || isBlankTimezone(raw)) return null
  const zone = canonicalTimezone(raw)
  if (!zone) throw createError({ statusCode: 422, message: TIMEZONE_REFUSAL })
  return zone
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
      // The outer column is spelled out: drizzle renders an interpolated column
      // unqualified inside a `sql` template, so `${tables.invite.id}` became a
      // bare `"id"` that Postgres resolved against events_rsvp — every invite
      // reported 0 responses. See the note at the top of ./admin.ts.
      rsvpCount: sql<number>`(select count(*)::int from events_rsvp r where r.invite_id = events_invite.id)`
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
    .orderBy(
      tables.timelineItem.sortOrder,
      tables.timelineItem.startsAt,
      tables.timelineItem.createdAt,
      // `id` last, and NOT optional: `applyTimelineItemMove` renumbers from this
      // same order, and on a tied itinerary a list that stops one column short
      // disagrees with it about which row is where — so the first click on the
      // arrows, which is the recovery path, moves the wrong item.
      tables.timelineItem.id
    )
}

/**
 * Ready media metadata for a planner of the event (no presigned URLs).
 *
 * THE SECOND READ PATH, and worth saying so out loud: `listMediaForPlanner` in
 * `server/domain/media.ts` answers the host screen and this one answers
 * `/api/v1`, with a different projection and a different order. A field added
 * to one and not to the other is INVISIBLE to `pnpm test` — the contract test
 * polices paths and methods and is blind to fields — and #35 shipped exactly
 * that for one smoke run: the machine surface reported `ticket: null` on a
 * ticket with a seat number written on it, because `v1-shapes.mediaItem` can
 * only project what it is handed.
 *
 * ONE LEFT JOIN rather than a second query: a gallery is read whole, and a
 * per-item lookup here is the N+1 `server/domain/admin.ts` has a note about at
 * the top of it.
 *
 * The detail's columns are selected FLAT and the object rebuilt below, because
 * a nested selection over a left join makes "no row" and "a row of nulls"
 * indistinguishable — which is the one distinction this table exists to keep
 * (an emptied detail is a state, not an absence). `detailId` is the sentinel
 * and it is a primary key, so it is null exactly when there is no row.
 */
export async function listMedia(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  const rows = await useDb()
    .select({
      id: tables.media.id,
      type: tables.media.type,
      fileName: tables.media.fileName,
      caption: tables.media.caption,
      takenAt: tables.media.takenAt,
      assignedRsvpId: tables.media.assignedRsvpId,
      timelineItemId: tables.media.timelineItemId,
      // The expense this item is the receipt for (#29). An id, not a URL: the
      // bytes stay in zäme and are served to guests there.
      expenseId: tables.media.expenseId,
      createdAt: tables.media.createdAt,
      // What is printed on the ticket (#35).
      detailId: tables.ticketDetail.id,
      bookingRef: tables.ticketDetail.bookingRef,
      carrier: tables.ticketDetail.carrier,
      seat: tables.ticketDetail.seat,
      coach: tables.ticketDetail.coach,
      travellerName: tables.ticketDetail.travellerName,
      validFrom: tables.ticketDetail.validFrom,
      validUntil: tables.ticketDetail.validUntil,
      note: tables.ticketDetail.note
    })
    .from(tables.media)
    .leftJoin(tables.ticketDetail, eq(tables.ticketDetail.mediaId, tables.media.id))
    .where(and(eq(tables.media.eventId, ev.id), eq(tables.media.status, 'ready')))
    .orderBy(desc(tables.media.createdAt))

  return rows.map(({
    detailId, bookingRef, carrier, seat, coach, travellerName, validFrom, validUntil, note, ...media
  }) => ({
    ...media,
    ticket: detailId === null
      ? null
      : { bookingRef, carrier, seat, coach, travellerName, validFrom, validUntil, note }
  }))
}

/* -------------------------------- writes --------------------------------- */

export interface CreateEventInput {
  title: string
  type?: 'hosted' | 'concert' | 'series' | 'trip' | 'party'
  description?: string | null
  posterUrl?: string | null
  startsAt?: DateInput
  endsAt?: DateInput
  /**
   * The wall clock this event's times are READ against (#31) — an IANA region
   * name, or null/absent for the viewer's own. Display only: `startsAt` and
   * `endsAt` above are instants and are stored unchanged whatever this says.
   */
  timezone?: string | null
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
  // The event's own currency, taken from the instance setting ONCE, here (#59).
  // After this the setting has nothing to do with this trip: moving it later
  // moves no money, and moving this trip's is a different screen with a
  // confirmation and a recompute behind it.
  const currency = await instanceBaseCurrency()
  // Refused BEFORE the transaction opens: a zone that is not one is the
  // caller's mistake, and there is no reason to have written a slug and a
  // planner row by the time we say so.
  const timezone = resolveDisplayTimezone(input.timezone)
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
      timezone,
      location: input.location ?? null,
      venueStation: input.venueStation ?? null,
      ticketUrl: input.ticketUrl ?? null,
      performerNote: input.performerNote ?? null,
      // Concert events are public by default (zaeme).
      isPublic: type === 'concert',
      parentId: input.parentId ?? null,
      cadence: input.cadence ?? null,
      currency
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
  /**
   * The display zone (#31). Absent leaves it alone; null or '' clears it, which
   * puts the event back on the viewer's own clock. Setting it moves no stored
   * instant — `startsAt` and `endsAt` are untouched by a zone change, which is
   * the whole point of it being a label.
   */
  timezone?: string | null
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
  // Note what is NOT here: nothing touches `startsAt`/`endsAt` because the zone
  // changed. A display zone that rewrote stored instants would move the event
  // every time somebody corrected its label.
  if (input.timezone !== undefined) updates.timezone = resolveDisplayTimezone(input.timezone)
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
  /**
   * The place this happens at, when the group has pinned one (#30). Optional
   * and staying optional: `location` above is the free-text fallback and is
   * what an item without a place still shows.
   */
  placeId?: string | null
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
      // `id` last here too. It changes no outcome — the tied rows share the
      // number this reads — but it keeps ONE rule true of every ordering of
      // this table, which is a rule a test can hold.
      .orderBy(tables.timelineItem.sortOrder, tables.timelineItem.id)
    const last = existing[existing.length - 1]
    if (last) sortOrder = (last.sortOrder ?? 0) + 10
  }

  // A place id is only ever this event's. `events_timeline_item.place_id`
  // cannot carry the composite foreign key the legs do — `on delete set null`
  // on one would null `event_id` with it — so this check IS the constraint on
  // this path, and it answers 422 rather than storing a plausible id from
  // another trip.
  if (input.placeId) await assertPlaceOnEvent(ev.id, input.placeId)

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
      placeId: input.placeId ?? null,
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
  /** Pin this item to a place, or `null` to unpin it (#30). */
  placeId?: string | null
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
  return applyTimelineItemUpdate({ eventId: ev.id, itemId, input })
}

/**
 * The write itself, once the caller has settled WHO is allowed to do it.
 *
 * Two callers authorise it two different ways: `updateTimelineItem` above asks
 * whether you plan this event, and `updateTimelineItemAsOwner` in `admin.ts`
 * asks whether you own this instance. Nothing in here checks anything — never
 * call it from a route handler that has not already asked one of those.
 *
 * The two ids arrive NAMED, not positional. Both are strings, so a call site
 * that swapped them would type-check, pass every test in the suite, and 404
 * every timeline PATCH in production — a silent total regression that nothing
 * structural can see. A parameter object is the only thing here that can.
 */
export interface ApplyTimelineItemUpdate {
  eventId: string
  itemId: string
  input: UpdateTimelineItemInput
}

export async function applyTimelineItemUpdate({ eventId, itemId, input }: ApplyTimelineItemUpdate) {
  // See `addTimelineItem`: this is the constraint on this column, and `null`
  // (unpin, keep the free text) is a legitimate value that skips it.
  if (input.placeId) await assertPlaceOnEvent(eventId, input.placeId)

  const updates: Record<string, unknown> = {}
  if (input.placeId !== undefined) updates.placeId = input.placeId
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
      .where(and(eq(tables.timelineItem.id, itemId), eq(tables.timelineItem.eventId, eventId)))
      .limit(1)
    if (!row) throw createError({ statusCode: 404, message: 'Timeline item not found' })
    return row
  }

  const [updated] = await db
    .update(tables.timelineItem)
    .set(updates)
    .where(and(eq(tables.timelineItem.id, itemId), eq(tables.timelineItem.eventId, eventId)))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Timeline item not found' })
  return updated
}

export type TimelineMove = 'up' | 'down'

/** Move an itinerary item one place (owner/co-planner only). */
export async function moveTimelineItem(userId: string, slug: string, itemId: string, direction: TimelineMove) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return applyTimelineItemMove({ eventId: ev.id, itemId, direction })
}

export interface ApplyTimelineItemMove {
  eventId: string
  itemId: string
  direction: TimelineMove
}

/**
 * Re-order an itinerary in ONE statement, and hand back the new order.
 *
 * This exists because the obvious client-side version is broken in a way that
 * cannot be seen. Both editors used to move an item by PATCHing two
 * `sortOrder`s in sequence — give the item its neighbour's number, give the
 * neighbour the item's. If the second PATCH does not land, the two rows are
 * left SHARING a number, and from then on every further attempt computes
 * `a === b`, writes the same value to both, returns 200 twice, and moves
 * nothing. The arrows go dead for that pair, silently and permanently.
 *
 * A tie does not even need a failure to arise: `/api/v1`'s `addTimelineItem`
 * accepts an explicit `sortOrder`, so Enterprise can create two items on the
 * same number by itself. That is now self-healing rather than permanent — see
 * the second property below.
 *
 * So reordering is one operation. The statement below RENUMBERS the whole
 * itinerary from its current display order — `row_number()`, times ten, `id`
 * as the final tiebreak so the numbering is total — with the moved item and
 * its neighbour transposed. Three properties follow, and the middle one is the
 * fix:
 *
 *  - it cannot half-apply, so it can never CREATE a tie;
 *  - it renumbers unconditionally, so it REMOVES any tie already there,
 *    whoever made it — including on a move it refuses;
 *  - a move off either end is a no-op rather than an error (the arrows are
 *    disabled there), and still normalises.
 *
 * ⚠️ THE `select … for update` IS LOAD-BEARING, and it is not there to make the
 * write atomic — the single statement already is. Two planners reordering the
 * same itinerary at once was enough to break the first property outright:
 *
 *   from `a:0 b:10 c:20 d:30`, T1 moves `b` down while T2, on a snapshot taken
 *   before T1 commits, moves `d` up, and the result is `a:0 b:20 d:20 c:30` —
 *   a tie, created by the operation that exists to remove them.
 *
 * `is distinct from` is what let that happen: it keeps `updated_at` still on
 * the rows that did not move, and in doing so drops them from the statement's
 * lock set, so a concurrent writer's change to them is never rechecked. Taking
 * every row of the itinerary explicitly restores the invariant while keeping
 * the optimisation. Ordering that lock by `id` also fixes a self-deadlock: two
 * sessions renumbering the same rows in `row_number()` order would take them
 * in different orders and wedge, which measured seven deadlocks in 9,000
 * concurrent moves.
 *
 * The display order this reads must agree with the order the ARROWS were drawn
 * from, down to the last tiebreak, or the first click on a tied itinerary moves
 * the wrong row — `listTimeline`, `eventTimelineAsOwner` and the guest view all
 * end `…, createdAt, id` for that reason and must keep doing so.
 *
 * Columns are spelled out rather than interpolated for the reason the top of
 * `admin.ts` gives at length: Drizzle renders an interpolated column
 * unqualified inside a `sql` template, and Postgres then resolves it against
 * the wrong table without erroring.
 */
export async function applyTimelineItemMove({ eventId, itemId, direction }: ApplyTimelineItemMove) {
  const delta = direction === 'up' ? -1 : 1

  await useDb().transaction(async (tx) => {
    // Every row of THIS itinerary, locked in a fixed order. See the note above:
    // without it `is distinct from` lets a concurrent move create the very tie
    // this operation exists to remove, and two movers can deadlock.
    const locked = await tx.execute(sql`
      select id from events_timeline_item where event_id = ${eventId} order by id for update
    `)
    const ids = new Set((locked.rows as Array<{ id: string }>).map(r => r.id))
    if (!ids.has(itemId)) throw createError({ statusCode: 404, message: 'Timeline item not found' })

    await tx.execute(sql`
      with ordered as (
        select id,
               (row_number() over (order by sort_order, starts_at nulls last, created_at, id) - 1)::int as idx
          from events_timeline_item
         where event_id = ${eventId}
      ),
      moved as (select idx from ordered where id = ${itemId}),
      target as (
        select case
                 when (select idx from moved) + ${delta} between 0 and (select max(idx) from ordered)
                   then (select idx from moved) + ${delta}
               end as idx
      ),
      renumbered as (
        select o.id,
               case
                 when (select idx from target) is null then o.idx
                 when o.id = ${itemId} then (select idx from target)
                 when o.idx = (select idx from target) then (select idx from moved)
                 else o.idx
               end as idx
          from ordered o
      )
      update events_timeline_item t
         set sort_order = renumbered.idx * 10,
             updated_at = now()
        from renumbered
       where t.id = renumbered.id
         and t.event_id = ${eventId}
         and t.sort_order is distinct from renumbered.idx * 10
    `)
  })

  return useDb()
    .select()
    .from(tables.timelineItem)
    .where(eq(tables.timelineItem.eventId, eventId))
    .orderBy(
      tables.timelineItem.sortOrder,
      tables.timelineItem.startsAt,
      tables.timelineItem.createdAt,
      tables.timelineItem.id
    )
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
