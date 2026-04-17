import { eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { event, eventInvite } from '#server/database/schema'

/**
 * Public lookup of an event by invite token. Returns the subset of event
 * fields safe to expose to unauthenticated visitors, plus invite metadata.
 *
 * Only returns the event if it is currently in a state that accepts RSVPs
 * (`polling` or `published`). Draft and completed/cancelled events are
 * treated as if the invite does not exist.
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!

  const [row] = await db
    .select({
      invite: eventInvite,
      event: event
    })
    .from(eventInvite)
    .innerJoin(event, eq(eventInvite.eventId, event.id))
    .where(eq(eventInvite.token, token))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }

  const ev = row.event
  const acceptsRsvp = ev.status === 'polling' || ev.status === 'published'
  if (!acceptsRsvp) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }

  return {
    token: row.invite.token,
    event: {
      id: ev.id,
      slug: ev.slug,
      title: ev.title,
      type: ev.type,
      status: ev.status,
      description: ev.description,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      location: ev.location,
      venueStation: ev.venueStation,
      ticketUrl: ev.ticketUrl,
      performerNote: ev.performerNote,
      isPublic: ev.isPublic
    }
  }
})
