import { and, eq, inArray, or } from 'drizzle-orm'
import { renderFeedIcs, type IcsEventInput } from '../../utils/ics'
import { resolveIcalToken, tables, useDb } from '../../domain/index'

/**
 * Per-attendee iCal feed: every event the bearer RSVP'd yes/maybe to. Served
 * by zäme (guest-facing links belong on this host — ADR-0019); same
 * implementation the Enterprise app carries, over the shared core. The token
 * is unguessable but treated as a credential.
 *
 * Route: `GET /calendar/{token}.ics`
 */
export default defineEventHandler(async (e) => {
  const raw = getRouterParam(e, 'token')!
  const token = raw.replace(/\.ics$/, '')

  const identity = await resolveIcalToken(token)
  if (!identity) throw createError({ statusCode: 404, message: 'Calendar feed not found' })

  const attendeeWhere = identity.userId
    ? eq(tables.rsvp.userId, identity.userId)
    : eq(tables.rsvp.guestEmail, identity.email!)

  const rsvps = await useDb()
    .select({ eventId: tables.rsvp.eventId })
    .from(tables.rsvp)
    .where(and(attendeeWhere, or(eq(tables.rsvp.status, 'yes'), eq(tables.rsvp.status, 'maybe'))))

  const eventIds = rsvps.map(r => r.eventId)
  const events: IcsEventInput[] = eventIds.length
    ? await useDb().select({
        id: tables.event.id, slug: tables.event.slug, title: tables.event.title,
        description: tables.event.description, startsAt: tables.event.startsAt,
        endsAt: tables.event.endsAt, location: tables.event.location,
        ticketUrl: tables.event.ticketUrl, updatedAt: tables.event.updatedAt
      }).from(tables.event).where(inArray(tables.event.id, eventIds))
    : []

  const body = renderFeedIcs(events)
  setHeader(e, 'Content-Type', 'text/calendar; charset=utf-8')
  setHeader(e, 'Cache-Control', 'private, max-age=300')
  setHeader(e, 'Content-Disposition', `attachment; filename="zaeme-${token.slice(0, 8)}.ics"`)
  return body
})
