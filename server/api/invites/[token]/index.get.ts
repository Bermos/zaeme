import { and, eq, or } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { resolveInviteToken } from '#server/utils/invite'
import { rsvp } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { invite: inv, event: ev } = await resolveInviteToken(token)

  const session = await optionalAuth(e)

  // Look up the caller's existing RSVP, if any — so the page can render
  // "edit" mode instead of the empty form.
  let existingRsvp = null
  if (session?.user) {
    const [row] = await db
      .select()
      .from(rsvp)
      .where(and(
        eq(rsvp.eventId, ev.id),
        or(eq(rsvp.userId, session.user.id), eq(rsvp.guestEmail, session.user.email))
      ))
      .limit(1)
    existingRsvp = row ?? null
  } else if (inv.email) {
    const [row] = await db
      .select()
      .from(rsvp)
      .where(and(eq(rsvp.eventId, ev.id), eq(rsvp.guestEmail, inv.email)))
      .limit(1)
    existingRsvp = row ?? null
  }

  return {
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
    },
    invite: {
      token: inv.token,
      label: inv.label,
      name: inv.name,
      email: inv.email,
      expiresAt: inv.expiresAt
    },
    session: session?.user
      ? { id: session.user.id, name: session.user.name, email: session.user.email }
      : null,
    existingRsvp
  }
})
