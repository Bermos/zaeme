import { and, asc, desc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import { generateUniqueSlug } from './slugify'
import { toDate, type EventDispatch } from './events-data'

/**
 * Recurring series (the movie-night cinema): a container event
 * (`type = 'series'`) with a standing member group, and scheduled occurrences
 * as child events (`parentId` → the series). Deliberately NOT an RRULE
 * engine — the host (or the Events department's AI) schedules each showing
 * explicitly; `event.cadence` is a human note ("every second Friday").
 * Members get a personalised invite per occurrence and simply sign up
 * (RSVP yes/no) — a series never runs a date poll (PUBLIC-SITE-PLAN).
 */

export interface SeriesMemberView {
  id: string
  name: string
  email: string
  createdAt: Date
}

export interface OccurrenceView {
  id: string
  slug: string
  title: string
  status: string
  posterUrl: string | null
  startsAt: Date | null
  endsAt: Date | null
  location: string | null
  yesCount: number
}

/** Load an event by slug and 422 unless it is a series container. */
async function loadSeriesBySlug(slug: string) {
  const ev = await loadEventBySlug(slug)
  if (ev.type !== 'series') {
    throw createError({ statusCode: 422, message: 'This event is not a series' })
  }
  return ev
}

/* --------------------------------- members --------------------------------- */

export async function listSeriesMembers(seriesId: string): Promise<SeriesMemberView[]> {
  const rows = await useDb()
    .select()
    .from(tables.seriesMember)
    .where(eq(tables.seriesMember.seriesId, seriesId))
    .orderBy(asc(tables.seriesMember.createdAt))
  return rows.map(r => ({ id: r.id, name: r.name, email: r.email, createdAt: r.createdAt }))
}

/** Add a member to the standing group (owner/co-planner only; idempotent by email). */
export async function addSeriesMember(
  userId: string,
  slug: string,
  input: { name: string, email: string }
) {
  const ev = await loadSeriesBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  const email = input.email.toLowerCase()

  await useDb()
    .insert(tables.seriesMember)
    .values({
      id: createId(),
      seriesId: ev.id,
      name: input.name,
      email,
      createdByUserId: userId
    })
    .onConflictDoUpdate({
      target: [tables.seriesMember.seriesId, tables.seriesMember.email],
      set: { name: input.name }
    })
  return listSeriesMembers(ev.id)
}

/** Remove a member from the standing group (owner/co-planner only). */
export async function removeSeriesMember(userId: string, slug: string, memberId: string) {
  const ev = await loadSeriesBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .delete(tables.seriesMember)
    .where(and(eq(tables.seriesMember.id, memberId), eq(tables.seriesMember.seriesId, ev.id)))
  return listSeriesMembers(ev.id)
}

/* ------------------------------- occurrences ------------------------------- */

/** The series' child events, upcoming first, each with its yes-count. */
export async function listOccurrences(seriesId: string): Promise<OccurrenceView[]> {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.event)
    .where(eq(tables.event.parentId, seriesId))
    .orderBy(desc(tables.event.startsAt))
  if (rows.length === 0) return []

  const rsvps = await db
    .select({ eventId: tables.rsvp.eventId, status: tables.rsvp.status })
    .from(tables.rsvp)
    .innerJoin(tables.event, eq(tables.rsvp.eventId, tables.event.id))
    .where(eq(tables.event.parentId, seriesId))

  return rows.map(ev => ({
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    status: ev.status,
    posterUrl: ev.posterUrl,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    location: ev.location,
    yesCount: rsvps.filter(r => r.eventId === ev.id && (r.status === 'yes' || r.status === 'cheering')).length
  }))
}

export interface ScheduleOccurrenceInput {
  /** The showing's title, e.g. the film — "Movie night: Heat (1995)". */
  title: string
  description?: string | null
  posterUrl?: string | null
  startsAt: string | Date
  endsAt?: string | Date | null
  location?: string | null
}

/**
 * Schedule the next occurrence of a series (owner/co-planner only): creates a
 * published child event carrying the series' planners, plus one personalised
 * invite per standing member — publishing fires the caller's dispatch, whose
 * `event.published` trigger emails every invite. Members then sign up (RSVP).
 */
export async function scheduleOccurrence(
  userId: string,
  seriesSlug: string,
  input: ScheduleOccurrenceInput,
  opts: { dispatch?: EventDispatch } = {}
) {
  const series = await loadSeriesBySlug(seriesSlug)
  await assertPlanner(series.id, userId, { roles: ['owner', 'co_planner'] })

  const startsAt = toDate(input.startsAt)
  if (!startsAt) {
    throw createError({ statusCode: 422, message: 'An occurrence needs a start time' })
  }

  const db = useDb()
  const [members, planners] = await Promise.all([
    listSeriesMembers(series.id),
    db.select().from(tables.eventPlanner).where(eq(tables.eventPlanner.eventId, series.id))
  ])

  const id = createId()
  const slug = await generateUniqueSlug(input.title)

  await db.transaction(async (tx) => {
    await tx.insert(tables.event).values({
      id,
      slug,
      title: input.title,
      type: 'hosted',
      status: 'published',
      description: input.description ?? series.description,
      posterUrl: input.posterUrl ?? null,
      startsAt,
      endsAt: toDate(input.endsAt),
      location: input.location ?? series.location,
      venueStation: series.venueStation,
      isPublic: false,
      parentId: series.id
    })
    // The series' whole planning team carries over to each showing.
    await tx.insert(tables.eventPlanner).values(planners.map(p => ({
      id: createId(),
      eventId: id,
      userId: p.userId,
      role: p.role
    })))
    if (members.length) {
      await tx.insert(tables.invite).values(members.map(m => ({
        id: createId(),
        eventId: id,
        token: createId(),
        label: m.name,
        email: m.email,
        name: m.name,
        maxUses: 1,
        createdByUserId: userId
      })))
    }
  })

  if (opts.dispatch) {
    await opts.dispatch('events/event.published', { eventId: id })
  }
  return { id, slug, invited: members.length }
}

/* ------------------------------ guest context ------------------------------ */

export interface SeriesContext {
  title: string
  cadence: string | null
  posterUrl: string | null
  /** Published sibling showings, for the cinema's "programme" strip. */
  upcoming: Array<{ title: string, startsAt: Date | null }>
  pastCount: number
}

/**
 * The cinema context for a guest looking at one showing: the series it belongs
 * to, what else is on the programme, and how many showings came before.
 */
export async function loadSeriesContext(parentId: string, occurrenceId: string): Promise<SeriesContext | null> {
  const db = useDb()
  const [series] = await db
    .select()
    .from(tables.event)
    .where(and(eq(tables.event.id, parentId), eq(tables.event.type, 'series')))
    .limit(1)
  if (!series) return null

  const siblings = await db
    .select({ id: tables.event.id, title: tables.event.title, startsAt: tables.event.startsAt, status: tables.event.status })
    .from(tables.event)
    .where(eq(tables.event.parentId, parentId))
    .orderBy(asc(tables.event.startsAt))

  const now = Date.now()
  return {
    title: series.title,
    cadence: series.cadence,
    posterUrl: series.posterUrl,
    upcoming: siblings
      .filter(s => s.id !== occurrenceId && s.status === 'published' && s.startsAt && s.startsAt.getTime() > now)
      .slice(0, 4)
      .map(s => ({ title: s.title, startsAt: s.startsAt })),
    pastCount: siblings.filter(s => s.startsAt && s.startsAt.getTime() <= now).length
  }
}
