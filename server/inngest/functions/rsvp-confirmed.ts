import { eq } from 'drizzle-orm'
import { inngest, RsvpConfirmedEvent } from '../client'
import { tables, useDb } from '../../domain/db'
import { getOrCreateIcalToken } from '../../domain/ical-token'
import { guestUser } from '../../database/schema/auth'
import { renderRsvpConfirmationEmail, sendEmail, publicSiteUrl } from '../../emails/index'
import { renderEventIcs } from '../../utils/ics'

/**
 * Send the attendee their RSVP confirmation, with an `.ics` attachment so the
 * gathering lands in their calendar and a link to their personal feed.
 */
export const rsvpConfirmed = inngest.createFunction(
  {
    id: 'rsvp-confirmed',
    name: 'Send RSVP confirmation',
    triggers: [{ event: RsvpConfirmedEvent }]
  },
  async ({ event: evt, step }) => {
    const { rsvpId } = evt.data

    const row = await step.run('load-rsvp', async () => {
      const [r] = await useDb()
        .select({ rsvp: tables.rsvp, event: tables.event, user: guestUser, invite: tables.invite })
        .from(tables.rsvp)
        .innerJoin(tables.event, eq(tables.rsvp.eventId, tables.event.id))
        .leftJoin(guestUser, eq(tables.rsvp.userId, guestUser.id))
        .leftJoin(tables.invite, eq(tables.rsvp.inviteId, tables.invite.id))
        .where(eq(tables.rsvp.id, rsvpId))
        .limit(1)
      return r ?? null
    })

    if (!row) return { skipped: 'rsvp-not-found' }
    const { rsvp: r, event: ev, user: u, invite: inv } = row

    // A declined RSVP gets no confirmation — there is nothing to confirm.
    if (r.status === 'no') return { skipped: 'declined' }

    const toAddress = u?.email ?? r.guestEmail
    if (!toAddress) return { skipped: 'no-email' }
    const recipientName = u?.name ?? r.guestName ?? null

    // Idempotent: the helper returns the existing token when one was issued.
    const calendarFeedUrl = await step.run('ensure-ical-token', async () => {
      if (r.status !== 'yes' && r.status !== 'maybe') return null
      const identity = u ? { userId: u.id } : r.guestEmail ? { email: r.guestEmail } : null
      if (!identity) return null
      const token = await getOrCreateIcalToken(identity)
      return publicSiteUrl(`/calendar/${token}.ics`)
    })

    const { html, text } = await renderRsvpConfirmationEmail({
      recipientName,
      eventTitle: ev.title,
      eventSlug: ev.slug,
      status: r.status,
      plusOne: r.plusOne,
      startsAt: ev.startsAt,
      endsAt: ev.endsAt,
      location: ev.location,
      inviteToken: inv?.token ?? null,
      calendarFeedUrl
    })

    const attachments: { filename: string, content: string, contentType: string }[] = []
    if (ev.startsAt && (r.status === 'yes' || r.status === 'maybe')) {
      attachments.push({
        filename: `${ev.slug}.ics`,
        content: renderEventIcs({
          id: ev.id,
          slug: ev.slug,
          title: ev.title,
          description: ev.description,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          location: ev.location,
          ticketUrl: ev.ticketUrl,
          updatedAt: ev.updatedAt
        }),
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH'
      })
    }

    await step.run('send-email', () => sendEmail({
      to: toAddress,
      subject: `RSVP confirmed — ${ev.title}`,
      html,
      text,
      tag: 'rsvp-confirmed',
      attachments
    }))

    return { sentTo: toAddress }
  }
)
