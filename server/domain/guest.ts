import { and, asc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { resolveInviteToken, bumpInviteUsage } from './invite'
import { summariseRsvps, type EventDispatch, type RsvpStatus, type RsvpSummary } from './events-data'
import { loadPoll, type PollOptionView, type PollAnswer } from './poll'
import { addContribution, claimContribution, listContributions, releaseContribution, type ContributionView } from './contributions'
import { addExpense, loadBudget, removeExpense, type AddExpenseInput } from './expenses'
import { loadSeriesContext, type SeriesContext } from './series'
import { listMessages, postMessage } from './chat'
import {
  confirmMediaUpload,
  findRsvpIdByEmail,
  listMediaForViewer,
  registerMediaUpload,
  type MediaType,
  type RegisterMediaInput
} from './media'

/**
 * The guest-facing surface (ADR-0019): everything a friend holding an invite
 * link can see and do, keyed by the capability token — view the gathering, see
 * who's coming, RSVP, vote on dates, claim bring-list items. Extracted from the
 * layer's guest handlers (originally zaeme `invites/[token]/*`) and extended
 * with the poll + bring list for the movie-night build.
 *
 * IDENTITY: a guest IS their lowercased email address. Every write below keys
 * on it — one RSVP per (event, email), one vote per (option, email), one series
 * membership per (series, email) — so a returning friend is recognised across
 * events without ever creating an account. An optional `zaeme_user` account
 * (magic link) adds nothing to a guest action; it only unlocks the cross-event
 * `/me` aggregation, which looks the same email up.
 */

/* ------------------------------ invite page ------------------------------- */

export interface AttendeeView {
  name: string
  status: RsvpStatus
  plusOne: boolean
  plusOneName: string | null
}

export interface InvitePage {
  event: {
    id: string
    slug: string
    title: string
    type: string
    status: string
    description: string | null
    posterUrl: string | null
    startsAt: Date | null
    endsAt: Date | null
    location: string | null
    venueStation: string | null
    ticketUrl: string | null
    performerNote: string | null
    isPublic: boolean
    parentId: string | null
  }
  invite: {
    token: string
    label: string | null
    name: string | null
    email: string | null
    expiresAt: Date | null
    tier: 'core' | 'general'
  }
  /** Who's coming — names only, no contact details (guest-visible). */
  attendees: AttendeeView[]
  summary: RsvpSummary
  timeline: Array<{
    id: string
    title: string
    description: string | null
    startsAt: Date | null
    endsAt: Date | null
    location: string | null
    type: string
    icon: string | null
  }>
  /** Date poll (present while the host is finding a date, i.e. status polling). */
  poll: PollOptionView[]
  contributions: ContributionView[]
  /** The targeted invitee's existing RSVP (personalised invites only). */
  existingRsvp: typeof tables.rsvp.$inferSelect | null
  /** The cinema context when this is a showing of a recurring series. */
  series: SeriesContext | null
  /** The trip budget (trips, or any event once an expense exists). */
  budget: Awaited<ReturnType<typeof loadBudget>> | null
}

/**
 * Everything the guest event page needs, in one resolve. The existing-RSVP
 * lookup stays limited to the invite's own email (personalised invites) so a
 * shared link can't probe other guests' details by email.
 */
export async function getInvitePage(token: string): Promise<InvitePage> {
  const { invite: inv, event: ev } = await resolveInviteToken(token)
  const db = useDb()

  const [rsvpRows, timeline, poll, contributions, series, budget] = await Promise.all([
    db.select().from(tables.rsvp).where(eq(tables.rsvp.eventId, ev.id)).orderBy(asc(tables.rsvp.createdAt)),
    db.select().from(tables.timelineItem)
      .where(eq(tables.timelineItem.eventId, ev.id))
      .orderBy(asc(tables.timelineItem.sortOrder), asc(tables.timelineItem.startsAt)),
    loadPoll(ev.id),
    listContributions(ev.id),
    ev.parentId ? loadSeriesContext(ev.parentId, ev.id) : Promise.resolve(null),
    loadBudget(ev.id)
  ])

  const attending = rsvpRows.filter(r => r.status !== 'no')
  const existingRsvp = inv.email
    ? rsvpRows.find(r => r.guestEmail === inv.email!.toLowerCase()) ?? null
    : null

  return {
    event: {
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      type: ev.type,
      status: ev.status,
      description: ev.description,
      posterUrl: ev.posterUrl,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      location: ev.location,
      venueStation: ev.venueStation,
      ticketUrl: ev.ticketUrl,
      performerNote: ev.performerNote,
      isPublic: ev.isPublic,
      parentId: ev.parentId
    },
    invite: {
      token: inv.token,
      label: inv.label,
      name: inv.name,
      email: inv.email,
      expiresAt: inv.expiresAt,
      tier: inv.tier as 'core' | 'general'
    },
    attendees: attending.map(r => ({
      name: r.guestName ?? 'Guest',
      status: r.status as RsvpStatus,
      plusOne: r.plusOne,
      plusOneName: r.plusOneName
    })),
    summary: summariseRsvps(rsvpRows),
    timeline: timeline.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      location: t.location,
      type: t.type,
      icon: t.icon
    })),
    poll,
    contributions,
    existingRsvp,
    series,
    // Budget stays a trip surface unless someone already recorded an expense.
    budget: ev.type === 'trip' || budget.expenses.length > 0 ? budget : null
  }
}

/* -------------------------------- RSVP ------------------------------------ */

export interface GuestRsvpInput {
  status: RsvpStatus
  plusOne?: boolean
  plusOneName?: string | null
  dietary?: string | null
  accessibility?: string | null
  notes?: string | null
  guestName: string
  guestEmail: string
}

/**
 * Guest RSVP via an invite token. Upserts by (event, email) and fires
 * `events/rsvp.confirmed` through the caller's dispatch (the
 * confirmation-email job listens on it).
 */
export async function saveGuestRsvp(
  token: string,
  body: GuestRsvpInput,
  opts: { dispatch?: EventDispatch } = {}
) {
  const { invite: inv, event: ev } = await resolveInviteToken(token)

  if (body.status === 'cheering' && ev.type !== 'concert') {
    throw createError({ statusCode: 422, message: 'Cheering is only valid for concert events' })
  }

  const guestEmail = body.guestEmail.toLowerCase()
  const guestName = body.guestName
  const db = useDb()

  const values = {
    status: body.status,
    plusOne: body.plusOne ?? false,
    plusOneName: body.plusOne ? (body.plusOneName ?? null) : null,
    dietary: body.dietary ?? null,
    accessibility: body.accessibility ?? null,
    notes: body.notes ?? null
  }

  const [existing] = await db.select().from(tables.rsvp)
    .where(and(eq(tables.rsvp.eventId, ev.id), eq(tables.rsvp.guestEmail, guestEmail)))
    .limit(1)

  let saved: typeof tables.rsvp.$inferSelect
  if (existing) {
    const [updated] = await db.update(tables.rsvp)
      .set({ ...values, guestName, guestEmail })
      .where(eq(tables.rsvp.id, existing.id))
      .returning()
    saved = updated!
  } else {
    const [inserted] = await db.insert(tables.rsvp)
      .values({ id: createId(), eventId: ev.id, inviteId: inv.id, userId: null, guestName, guestEmail, ...values })
      .returning()
    saved = inserted!
    await bumpInviteUsage(inv.id)
  }

  if (opts.dispatch) {
    await opts.dispatch('events/rsvp.confirmed', {
      rsvpId: saved.id, eventId: ev.id, userId: saved.userId, guestEmail: saved.guestEmail
    })
  }

  return saved
}

/* ------------------------------ poll voting -------------------------------- */

export interface GuestVotesInput {
  guestName: string
  guestEmail: string
  votes: Array<{ optionId: string, answer: PollAnswer }>
}

/**
 * Cast (or update) a guest's availability for the event's date options — one
 * upsert per option, keyed by (option, email). Only while the poll is open.
 */
export async function castDateVotes(token: string, input: GuestVotesInput) {
  const { event: ev } = await resolveInviteToken(token)
  if (ev.status !== 'polling') {
    throw createError({ statusCode: 422, message: 'This event is not currently polling for dates' })
  }

  const guestEmail = input.guestEmail.toLowerCase()
  const db = useDb()

  // Validate the options belong to this event before writing.
  const options = await db
    .select({ id: tables.dateOption.id })
    .from(tables.dateOption)
    .where(eq(tables.dateOption.eventId, ev.id))
  const valid = new Set(options.map(o => o.id))
  for (const v of input.votes) {
    if (!valid.has(v.optionId)) {
      throw createError({ statusCode: 422, message: 'Unknown date option' })
    }
  }

  for (const v of input.votes) {
    await db
      .insert(tables.dateVote)
      .values({
        id: createId(),
        optionId: v.optionId,
        eventId: ev.id,
        guestName: input.guestName,
        guestEmail,
        answer: v.answer
      })
      .onConflictDoUpdate({
        target: [tables.dateVote.optionId, tables.dateVote.guestEmail],
        set: { answer: v.answer, guestName: input.guestName }
      })
  }

  return loadPoll(ev.id)
}

/* --------------------------- bring-list actions ---------------------------- */

export interface GuestIdentity {
  guestName: string
  guestEmail: string
}

/** A guest adds a bring-list item via their invite link (optionally claiming it). */
export async function guestAddContribution(
  token: string,
  input: { title: string, category?: 'food' | 'drink' | 'other', quantity?: string | null, note?: string | null, claim?: boolean },
  identity: GuestIdentity
) {
  const { event: ev } = await resolveInviteToken(token)
  return addContribution(
    ev.id,
    { title: input.title, category: input.category, quantity: input.quantity, note: input.note },
    { guestName: identity.guestName, guestEmail: identity.guestEmail },
    { claim: input.claim }
  )
}

/** A guest claims an unclaimed bring-list item. */
export async function guestClaimContribution(token: string, contributionId: string, identity: GuestIdentity) {
  const { event: ev } = await resolveInviteToken(token)
  return claimContribution(ev.id, contributionId, {
    name: identity.guestName,
    email: identity.guestEmail
  })
}

/** A guest releases their own claim. */
export async function guestReleaseContribution(token: string, contributionId: string, email: string) {
  const { event: ev } = await resolveInviteToken(token)
  return releaseContribution(ev.id, contributionId, { email })
}

/* ------------------------------ trip expenses ------------------------------ */

/** A guest records an expense they fronted (or one they know about) via their link. */
export async function guestAddExpense(token: string, input: AddExpenseInput, identity: GuestIdentity) {
  const { event: ev } = await resolveInviteToken(token)
  return addExpense(ev.id, input, {
    guestEmail: identity.guestEmail
  })
}

/** A guest removes an expense they recorded or paid. */
export async function guestRemoveExpense(token: string, expenseId: string, email: string) {
  const { event: ev } = await resolveInviteToken(token)
  await removeExpense(ev.id, expenseId, { email })
  return loadBudget(ev.id)
}

/** The budget refresh for the guest page. */
export async function guestLoadBudget(token: string) {
  const { event: ev } = await resolveInviteToken(token)
  return loadBudget(ev.id)
}

/* -------------------------------- group chat ------------------------------- */

/** Chat messages via an invite link; pass `afterId` when polling for new ones. */
export async function guestListMessages(token: string, opts: { afterId?: string | null } = {}) {
  const { event: ev } = await resolveInviteToken(token)
  return listMessages(ev.id, opts)
}

/** Post to the event chat via an invite link. */
export async function guestPostMessage(token: string, body: string, identity: GuestIdentity) {
  const { event: ev } = await resolveInviteToken(token)
  return postMessage(ev.id, {
    body,
    authorName: identity.guestName,
    authorEmail: identity.guestEmail
  })
}

/* --------------------------------- media ----------------------------------- */

/** Guests may add to the shared gallery; papers (documents/tickets) are host-managed. */
const GUEST_UPLOAD_TYPES: MediaType[] = ['photo', 'video']

/**
 * What this invite's holder may see: the gallery, the shared documents, and —
 * matched through the viewer's email — their own tickets. Storage keys only;
 * the app signs download URLs.
 */
export async function guestListMedia(token: string, viewerEmail: string | null) {
  const { event: ev } = await resolveInviteToken(token)
  return listMediaForViewer(ev.id, viewerEmail ?? null)
}

/**
 * Two-step guest upload, DB half of step 1 (photos/videos only). The upload is
 * attributed to the guest's RSVP when they have one.
 */
export async function guestRegisterMediaUpload(token: string, input: RegisterMediaInput, identity: GuestIdentity) {
  const { event: ev } = await resolveInviteToken(token)
  if (!GUEST_UPLOAD_TYPES.includes(input.type)) {
    throw createError({ statusCode: 403, message: 'Guests can upload photos and videos; the host manages documents and tickets' })
  }
  const rsvpId = await findRsvpIdByEmail(ev.id, identity.guestEmail)
  return { ...(await registerMediaUpload(ev.id, input, { rsvpId })), rsvpId }
}

/** Two-step guest upload, step 2: confirm — only the uploader's own pending row. */
export async function guestConfirmMediaUpload(
  token: string,
  mediaId: string,
  input: { caption?: string | null, takenAt?: string | null },
  identity: GuestIdentity
) {
  const { event: ev } = await resolveInviteToken(token)
  const rsvpId = await findRsvpIdByEmail(ev.id, identity.guestEmail)
  if (!rsvpId) {
    throw createError({ statusCode: 403, message: 'RSVP first — then add your photos' })
  }
  return confirmMediaUpload(ev.id, mediaId, input, { requireUploadedByRsvpId: rsvpId })
}

/* --------------------------- account aggregation --------------------------- */

/**
 * Every invite + RSVP attached to an email address, across events — the
 * account-gated "all my invites in one place" view (/me). Aggregation requires
 * a signed-in zäme account; capability links stay per-event. This email match
 * IS zäme's cross-event guest identity.
 */
export async function listInvitesForEmail(email: string) {
  const normalized = email.toLowerCase()
  const db = useDb()

  const [invites, rsvps] = await Promise.all([
    db
      .select({
        token: tables.invite.token,
        label: tables.invite.label,
        revokedAt: tables.invite.revokedAt,
        expiresAt: tables.invite.expiresAt,
        eventSlug: tables.event.slug,
        eventTitle: tables.event.title,
        eventStatus: tables.event.status,
        startsAt: tables.event.startsAt,
        location: tables.event.location
      })
      .from(tables.invite)
      .innerJoin(tables.event, eq(tables.invite.eventId, tables.event.id))
      .where(eq(tables.invite.email, normalized)),
    db
      .select({
        status: tables.rsvp.status,
        inviteId: tables.rsvp.inviteId,
        inviteToken: tables.invite.token,
        eventSlug: tables.event.slug,
        eventTitle: tables.event.title,
        eventStatus: tables.event.status,
        startsAt: tables.event.startsAt,
        location: tables.event.location
      })
      .from(tables.rsvp)
      .innerJoin(tables.event, eq(tables.rsvp.eventId, tables.event.id))
      .leftJoin(tables.invite, eq(tables.rsvp.inviteId, tables.invite.id))
      .where(eq(tables.rsvp.guestEmail, normalized))
  ])

  return { invites, rsvps }
}
