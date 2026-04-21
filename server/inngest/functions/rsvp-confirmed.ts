import * as React from 'react'
import { eq } from 'drizzle-orm'
import { inngest, RsvpConfirmedEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEventIcs } from '#server/utils/ics'
import { getOrCreateIcalToken } from '#server/utils/ical'
import { renderEmail } from '#server/emails/render'
import { RsvpConfirmationEmail } from '#server/emails/rsvp-confirmation'
import { absoluteUrl } from '#server/emails/_format'
import { event, rsvp, user, invite } from '#server/database/schema'

/**
 * Send the attendee their RSVP confirmation email with an `.ics`
 * attachment so the event lands in their calendar.
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
      const [r] = await db
        .select({
          rsvp,
          event,
          user,
          invite
        })
        .from(rsvp)
        .innerJoin(event, eq(rsvp.eventId, event.id))
        .leftJoin(user, eq(rsvp.userId, user.id))
        .leftJoin(invite, eq(rsvp.inviteId, invite.id))
        .where(eq(rsvp.id, rsvpId))
        .limit(1)
      return r ?? null
    })

    if (!row) return { skipped: 'rsvp-not-found' }

    const { rsvp: r, event: ev, user: u, invite: inv } = row

    // Only send confirmations for affirmative RSVPs — 'no' responses get a
    // short acknowledgement only when planners enable it (future work).
    if (r.status === 'no') return { skipped: 'declined' }

    const toAddress = u?.email ?? r.guestEmail
    if (!toAddress) return { skipped: 'no-email' }

    const recipientName = u?.name ?? r.guestName ?? null

    // Ensure an iCal feed token exists for the attendee so we can include
    // a subscription link in the email body. Safe to run on every RSVP —
    // the helper is idempotent.
    const calendarFeedUrl = await step.run('ensure-ical-token', async () => {
      if (r.status !== 'yes' && r.status !== 'maybe') return null
      const identity = u
        ? { userId: u.id }
        : r.guestEmail
          ? { email: r.guestEmail }
          : null
      if (!identity) return null
      const token = await getOrCreateIcalToken(identity)
      return absoluteUrl(`/calendar/${token}.ics`)
    })

    const { html, text } = await renderEmail(
      React.createElement(RsvpConfirmationEmail, {
        recipientName,
        eventTitle: ev.title,
        eventSlug: ev.slug,
        status: r.status as 'yes' | 'maybe' | 'no' | 'cheering',
        plusOne: r.plusOne,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        location: ev.location,
        inviteToken: inv?.token ?? null,
        calendarFeedUrl
      })
    )

    const attachments: { filename: string, content: string, contentType: string }[] = []
    if (ev.startsAt && (r.status === 'yes' || r.status === 'maybe')) {
      const ics = renderEventIcs({
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
      attachments.push({
        filename: `${ev.slug}.ics`,
        content: ics,
        contentType: 'text/calendar; charset=utf-8; method=PUBLISH'
      })
    }

    await step.run('send-email', async () => {
      await sendEmail({
        to: toAddress,
        subject: `RSVP confirmed — ${ev.title}`,
        html,
        text,
        tag: 'rsvp-confirmed',
        attachments
      })
    })

    return { sentTo: toAddress }
  }
)
