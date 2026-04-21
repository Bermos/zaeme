import * as React from 'react'
import { eq } from 'drizzle-orm'
import { inngest, EventCancelledEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEmail } from '#server/emails/render'
import { EventCancelledEmail } from '#server/emails/event-cancelled'
import { event, rsvp, user } from '#server/database/schema'

/**
 * Notify every attendee that the event was cancelled. We broadcast to any
 * RSVP status — 'no' respondents may still appreciate knowing plans have
 * changed (e.g. they could have come after all).
 */
export const eventCancelled = inngest.createFunction(
  {
    id: 'event-cancelled',
    name: 'Send event cancellation',
    triggers: [{ event: EventCancelledEvent }]
  },
  async ({ event: evt, step }) => {
    const { eventId, reason } = evt.data

    const ev = await step.run('load-event', async () => {
      const [row] = await db.select().from(event).where(eq(event.id, eventId)).limit(1)
      return row ?? null
    })

    if (!ev) return { skipped: 'event-not-found' }

    const recipients = await step.run('load-recipients', async () => {
      return db
        .select({ rsvp, user })
        .from(rsvp)
        .leftJoin(user, eq(rsvp.userId, user.id))
        .where(eq(rsvp.eventId, ev.id))
    })

    let sent = 0
    const seen = new Set<string>()
    for (const r of recipients) {
      const to = r.user?.email ?? r.rsvp.guestEmail
      if (!to) continue
      if (seen.has(to.toLowerCase())) continue
      seen.add(to.toLowerCase())
      await step.run(`send-${r.rsvp.id}`, async () => {
        const { html, text } = await renderEmail(
          React.createElement(EventCancelledEmail, {
            recipientName: r.user?.name ?? r.rsvp.guestName ?? null,
            eventTitle: ev.title,
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            location: ev.location,
            reason: reason ?? null
          })
        )
        await sendEmail({
          to,
          subject: `Cancelled — ${ev.title}`,
          html,
          text,
          tag: 'event-cancelled'
        })
      })
      sent += 1
    }

    return { sent }
  }
)
