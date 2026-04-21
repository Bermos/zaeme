import * as React from 'react'
import { eq } from 'drizzle-orm'
import { inngest, EventReminderEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEmail } from '#server/emails/render'
import { EventReminderEmail } from '#server/emails/event-reminder'
import { event, rsvp, user, invite } from '#server/database/schema'

/**
 * Fan out the 48h reminder email to every attendee that has RSVPed 'yes'
 * or 'maybe'. Scheduled by the `event.published` function.
 */
export const eventReminder = inngest.createFunction(
  {
    id: 'event-reminder',
    name: 'Send 48h reminder',
    triggers: [{ event: EventReminderEvent }]
  },
  async ({ event: evt, step }) => {
    const { eventId } = evt.data

    const ev = await step.run('load-event', async () => {
      const [row] = await db.select().from(event).where(eq(event.id, eventId)).limit(1)
      return row ?? null
    })

    if (!ev) return { skipped: 'event-not-found' }
    if (ev.status !== 'published') return { skipped: `status-${ev.status}` }
    if (!ev.startsAt) return { skipped: 'no-start' }

    const recipients = await step.run('load-recipients', async () => {
      return db
        .select({
          rsvp,
          user,
          invite
        })
        .from(rsvp)
        .leftJoin(user, eq(rsvp.userId, user.id))
        .leftJoin(invite, eq(rsvp.inviteId, invite.id))
        .where(eq(rsvp.eventId, ev.id))
        .then(rows => rows.filter(r => r.rsvp.status === 'yes' || r.rsvp.status === 'maybe'))
    })

    let sent = 0
    for (const r of recipients) {
      const to = r.user?.email ?? r.rsvp.guestEmail
      if (!to) continue
      await step.run(`send-${r.rsvp.id}`, async () => {
        const { html, text } = await renderEmail(
          React.createElement(EventReminderEmail, {
            recipientName: r.user?.name ?? r.rsvp.guestName ?? null,
            eventTitle: ev.title,
            eventSlug: ev.slug,
            startsAt: ev.startsAt!,
            endsAt: ev.endsAt,
            location: ev.location,
            inviteToken: r.invite?.token ?? null
          })
        )
        await sendEmail({
          to,
          subject: `${ev.title} is in 48 hours`,
          html,
          text,
          tag: 'event-reminder'
        })
      })
      sent += 1
    }

    return { sent }
  }
)
