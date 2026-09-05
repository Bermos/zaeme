import { renderEventIcs, type IcsEventInput } from '../../../utils/ics'
import { resolveInviteToken } from '../../../domain/index'

/**
 * Add-to-calendar for a guest: the event as a single-VEVENT .ics, gated by the
 * same invite capability token as the page. Only meaningful once a date is
 * locked (409 while polling).
 *
 * Route: `GET /i/{token}/calendar.ics`
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { event: ev } = await resolveInviteToken(token)

  if (!ev.startsAt) {
    throw createError({ statusCode: 409, message: 'The date has not been locked yet' })
  }

  const input: IcsEventInput = {
    id: ev.id,
    slug: ev.slug,
    title: ev.title,
    description: ev.description,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    location: ev.location,
    ticketUrl: ev.ticketUrl,
    updatedAt: ev.updatedAt
  }
  const body = renderEventIcs(input)

  setHeader(e, 'Content-Type', 'text/calendar; charset=utf-8')
  setHeader(e, 'Cache-Control', 'private, max-age=300')
  setHeader(e, 'Content-Disposition', `attachment; filename="${ev.slug}.ics"`)
  return body
})
