import { eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { assertPlanner } from '#server/utils/permissions'
import { renderEventIcs } from '#server/utils/ics'
import { event } from '#server/database/schema'

/**
 * Per-event iCal feed. Public events are accessible without authentication
 * (as documented in `ARCHITECTURE.md`); private events require the
 * requester to be a planner on the event.
 *
 * Route: `GET /events/{slug}/calendar.ics`
 */
export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!

  const [ev] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!ev) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  if (!ev.isPublic) {
    const session = await optionalAuth(e)
    if (!session) {
      throw createError({ statusCode: 404, message: 'Event not found' })
    }
    // Throws 403 if the user isn't a planner on this event.
    await assertPlanner(ev.id, session.user.id)
  }

  if (!ev.startsAt) {
    throw createError({ statusCode: 409, message: 'Event has no scheduled start time yet' })
  }

  const body = renderEventIcs({
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    description: ev.description,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    location: ev.location,
    ticketUrl: ev.ticketUrl,
    updatedAt: ev.updatedAt
  })

  setHeader(e, 'Content-Type', 'text/calendar; charset=utf-8')
  setHeader(e, 'Cache-Control', 'public, max-age=300')
  setHeader(e, 'Content-Disposition', `attachment; filename="${ev.slug}.ics"`)
  return body
})
