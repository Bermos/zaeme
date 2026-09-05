import { and, asc, eq, gte, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { summariseRsvps, type EventDispatch, type RsvpStatus, type RsvpSummary } from './events-data'

/**
 * The open surface (no invite token): public events — concerts mostly — listed
 * and viewable by anyone, with an "I go" for signed-in zäme users so people
 * who know each other can find each other and coordinate. The page is public;
 * *acting* on it requires an account (the caller passes the session identity),
 * unlike token pages where the link itself is the credential.
 */

export interface PublicEventCard {
  slug: string
  title: string
  type: string
  status: string
  posterUrl: string | null
  startsAt: Date | null
  location: string | null
  performerNote: string | null
  goingCount: number
}

/** Upcoming public events (newest-first past the horizon it keeps yesterday's). */
export async function listPublicEvents(): Promise<PublicEventCard[]> {
  const db = useDb()
  const horizon = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(tables.event)
    .where(and(
      eq(tables.event.isPublic, true),
      eq(tables.event.status, 'published'),
      gte(tables.event.startsAt, horizon)
    ))
    .orderBy(asc(tables.event.startsAt))
  if (rows.length === 0) return []

  const rsvps = await db
    .select({ eventId: tables.rsvp.eventId, status: tables.rsvp.status, plusOne: tables.rsvp.plusOne })
    .from(tables.rsvp)
    .where(inArray(tables.rsvp.eventId, rows.map(r => r.id)))

  return rows.map(ev => ({
    slug: ev.slug,
    title: ev.title,
    type: ev.type,
    status: ev.status,
    posterUrl: ev.posterUrl,
    startsAt: ev.startsAt,
    location: ev.location,
    performerNote: ev.performerNote,
    goingCount: rsvps.filter(r => r.eventId === ev.id && r.status !== 'no').length
  }))
}

export interface PublicEventPage {
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
  }
  /** Who's going — names only, so people can find each other. */
  attendees: Array<{ name: string, status: RsvpStatus }>
  summary: RsvpSummary
}

/** Load a public event by slug, 404-ing anything not published for the world. */
export async function getPublicEventPage(slug: string): Promise<PublicEventPage> {
  const [ev] = await useDb()
    .select()
    .from(tables.event)
    .where(eq(tables.event.slug, slug))
    .limit(1)
  if (!ev || !ev.isPublic || (ev.status !== 'published' && ev.status !== 'completed')) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  const rsvpRows = await useDb()
    .select()
    .from(tables.rsvp)
    .where(eq(tables.rsvp.eventId, ev.id))
    .orderBy(asc(tables.rsvp.createdAt))

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
      performerNote: ev.performerNote
    },
    attendees: rsvpRows
      .filter(r => r.status !== 'no')
      .map(r => ({ name: r.guestName ?? 'Someone', status: r.status as RsvpStatus })),
    summary: summariseRsvps(rsvpRows)
  }
}

/**
 * "I go" on a public event — the signed-in identity is the RSVP identity
 * (accounts required here: no token exists to act as the credential). Upserts
 * by (event, email) exactly like the guest flow.
 */
export async function savePublicRsvp(
  slug: string,
  status: RsvpStatus,
  identity: { userId: string, name: string, email: string },
  opts: { dispatch?: EventDispatch } = {}
) {
  const [ev] = await useDb()
    .select()
    .from(tables.event)
    .where(eq(tables.event.slug, slug))
    .limit(1)
  if (!ev || !ev.isPublic) throw createError({ statusCode: 404, message: 'Event not found' })
  if (ev.status !== 'published') {
    throw createError({ statusCode: 403, message: 'Event is not currently accepting RSVPs' })
  }
  if (status === 'cheering' && ev.type !== 'concert') {
    throw createError({ statusCode: 422, message: 'Cheering is only valid for concert events' })
  }

  const guestEmail = identity.email.toLowerCase()
  const db = useDb()

  const [existing] = await db
    .select()
    .from(tables.rsvp)
    .where(and(eq(tables.rsvp.eventId, ev.id), eq(tables.rsvp.guestEmail, guestEmail)))
    .limit(1)

  let saved: typeof tables.rsvp.$inferSelect
  if (existing) {
    const [updated] = await db
      .update(tables.rsvp)
      .set({ status, guestName: identity.name })
      .where(eq(tables.rsvp.id, existing.id))
      .returning()
    saved = updated!
  } else {
    const [inserted] = await db
      .insert(tables.rsvp)
      .values({
        id: createId(),
        eventId: ev.id,
        inviteId: null,
        userId: identity.userId,
        guestName: identity.name,
        guestEmail,
        status
      })
      .returning()
    saved = inserted!
  }

  if (opts.dispatch) {
    await opts.dispatch('events/rsvp.confirmed', {
      rsvpId: saved.id, eventId: ev.id, userId: saved.userId, guestEmail: saved.guestEmail
    })
  }
  return saved
}

/** True when this email has a non-"no" RSVP on the event — gates the public chat. */
export async function isPublicAttendee(eventId: string, email: string): Promise<boolean> {
  const [row] = await useDb()
    .select({ status: tables.rsvp.status })
    .from(tables.rsvp)
    .where(and(eq(tables.rsvp.eventId, eventId), eq(tables.rsvp.guestEmail, email.toLowerCase())))
    .limit(1)
  return !!row && row.status !== 'no'
}
