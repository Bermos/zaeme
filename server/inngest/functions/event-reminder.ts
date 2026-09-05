import { eq } from 'drizzle-orm'
import { inngest, EventReminderEvent } from '../client'
import { tables, useDb } from '../../domain/db'
import { guestUser } from '../../database/schema/auth'
import { renderEventReminderEmail, sendEmail } from '../../emails/index'

/**
 * Fan the 48h reminder out to every attendee who said yes or maybe. Scheduled
 * by `event.published`, so it can arrive long after the host walked away — it
 * re-checks that the event is still published and still has a start time.
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
      const [row] = await useDb().select().from(tables.event).where(eq(tables.event.id, eventId)).limit(1)
      return row ?? null
    })
    if (!ev) return { skipped: 'event-not-found' }
    if (ev.status !== 'published') return { skipped: `status-${ev.status}` }
    if (!ev.startsAt) return { skipped: 'no-start' }

    const recipients = await step.run('load-recipients', async () => {
      const rows = await useDb()
        .select({ rsvp: tables.rsvp, user: guestUser, invite: tables.invite })
        .from(tables.rsvp)
        .leftJoin(guestUser, eq(tables.rsvp.userId, guestUser.id))
        .leftJoin(tables.invite, eq(tables.rsvp.inviteId, tables.invite.id))
        .where(eq(tables.rsvp.eventId, ev.id))
      return rows.filter(r => r.rsvp.status === 'yes' || r.rsvp.status === 'maybe')
    })

    let sent = 0
    for (const r of recipients) {
      const to = r.user?.email ?? r.rsvp.guestEmail
      if (!to) continue
      await step.run(`send-${r.rsvp.id}`, async () => {
        const { html, text } = await renderEventReminderEmail({
          recipientName: r.user?.name ?? r.rsvp.guestName ?? null,
          eventTitle: ev.title,
          eventSlug: ev.slug,
          startsAt: ev.startsAt!,
          endsAt: ev.endsAt,
          location: ev.location,
          inviteToken: r.invite?.token ?? null
        })
        await sendEmail({ to, subject: `${ev.title} is in 48 hours`, html, text, tag: 'event-reminder' })
      })
      sent += 1
    }

    return { sent }
  }
)
