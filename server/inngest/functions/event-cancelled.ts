import { eq } from 'drizzle-orm'
import { inngest, EventCancelledEvent } from '../client'
import { tables, useDb } from '../../domain/db'
import { guestUser } from '../../database/schema/auth'
import { renderEventCancelledEmail, sendEmail } from '../../emails/index'

/**
 * Tell everyone the gathering is off. Deliberately broadcast to every RSVP
 * status, deduped by address: someone who answered "no" may still want to know
 * plans changed — they might have come after all.
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
      const [row] = await useDb().select().from(tables.event).where(eq(tables.event.id, eventId)).limit(1)
      return row ?? null
    })
    if (!ev) return { skipped: 'event-not-found' }

    const recipients = await step.run('load-recipients', () =>
      useDb()
        .select({ rsvp: tables.rsvp, user: guestUser })
        .from(tables.rsvp)
        .leftJoin(guestUser, eq(tables.rsvp.userId, guestUser.id))
        .where(eq(tables.rsvp.eventId, ev.id))
    )

    let sent = 0
    const seen = new Set<string>()
    for (const r of recipients) {
      const to = r.user?.email ?? r.rsvp.guestEmail
      if (!to || seen.has(to.toLowerCase())) continue
      seen.add(to.toLowerCase())
      await step.run(`send-${r.rsvp.id}`, async () => {
        const { html, text } = await renderEventCancelledEmail({
          recipientName: r.user?.name ?? r.rsvp.guestName ?? null,
          eventTitle: ev.title,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          location: ev.location,
          reason: reason ?? null
        })
        await sendEmail({ to, subject: `Cancelled — ${ev.title}`, html, text, tag: 'event-cancelled' })
      })
      sent += 1
    }

    return { sent }
  }
)
