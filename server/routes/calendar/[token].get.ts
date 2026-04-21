import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { resolveIcalToken } from '#server/utils/ical'
import { renderFeedIcs, type IcsEventInput } from '#server/utils/ics'
import { event, rsvp } from '#server/database/schema'

/**
 * Per-attendee iCal feed. The bearer of the token receives a live feed of
 * every event they have RSVP'd 'yes' or 'maybe' to. The token is
 * unguessable but must still be treated as a credential — do not return
 * information that the attendee would not already see on the event page.
 *
 * Route: `GET /calendar/{token}.ics`
 */
export default defineEventHandler(async (e) => {
  const raw = getRouterParam(e, 'token')!
  // Strip the `.ics` suffix that lives in the URL but not in our token store.
  const token = raw.replace(/\.ics$/, '')

  const identity = await resolveIcalToken(token)
  if (!identity) {
    throw createError({ statusCode: 404, message: 'Calendar feed not found' })
  }

  // Look up all RSVPs for this identity, then load the matching events.
  const attendeeWhere = identity.userId
    ? eq(rsvp.userId, identity.userId)
    : eq(rsvp.guestEmail, identity.email!)

  const rsvps = await db
    .select({ eventId: rsvp.eventId, status: rsvp.status })
    .from(rsvp)
    .where(and(attendeeWhere, or(eq(rsvp.status, 'yes'), eq(rsvp.status, 'maybe'))))

  const eventIds = rsvps.map(r => r.eventId)
  const events: IcsEventInput[] = eventIds.length
    ? await db
        .select({
          id: event.id,
          slug: event.slug,
          title: event.title,
          description: event.description,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          location: event.location,
          ticketUrl: event.ticketUrl,
          updatedAt: event.updatedAt
        })
        .from(event)
        .where(inArray(event.id, eventIds))
    : []

  const body = renderFeedIcs(events)
  setHeader(e, 'Content-Type', 'text/calendar; charset=utf-8')
  setHeader(e, 'Cache-Control', 'private, max-age=300')
  setHeader(e, 'Content-Disposition', `attachment; filename="zaeme-${token.slice(0, 8)}.ics"`)
  return body
})
