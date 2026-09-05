import { and, eq, isNotNull } from 'drizzle-orm'
import { inngest, EventPublishedEvent } from '../client'
import { tables, useDb } from '../../domain/db'
import { guestUser } from '../../database/schema/auth'
import { renderInviteEmail, sendEmail } from '../../emails/index'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Send the invite email to every *targeted* invite on the event — one with an
 * email address. Shareable (email-less) links are skipped: those are handed
 * out by the host out-of-band.
 *
 * Then schedule the 48h reminder, if the event starts more than 48h out.
 */
export const eventPublished = inngest.createFunction(
  {
    id: 'event-published',
    name: 'Send event invite emails',
    triggers: [{ event: EventPublishedEvent }]
  },
  async ({ event: evt, step }) => {
    const { eventId } = evt.data

    const ev = await step.run('load-event', async () => {
      const [row] = await useDb().select().from(tables.event).where(eq(tables.event.id, eventId)).limit(1)
      return row ?? null
    })
    if (!ev) return { skipped: 'event-not-found' }

    const invites = await step.run('load-invites', () =>
      useDb()
        .select()
        .from(tables.invite)
        .where(and(eq(tables.invite.eventId, ev.id), isNotNull(tables.invite.email)))
    )

    const host = await step.run('load-host', async () => {
      const [row] = await useDb()
        .select({ name: guestUser.name })
        .from(tables.eventPlanner)
        .innerJoin(guestUser, eq(tables.eventPlanner.userId, guestUser.id))
        .where(and(eq(tables.eventPlanner.eventId, ev.id), eq(tables.eventPlanner.role, 'owner')))
        .limit(1)
      return row?.name ?? null
    })

    let sent = 0
    for (const inv of invites) {
      if (inv.revokedAt || !inv.email) continue
      await step.run(`send-${inv.id}`, async () => {
        const { html, text } = await renderInviteEmail({
          recipientName: inv.name,
          hostName: host,
          eventTitle: ev.title,
          eventType: ev.type,
          eventDescription: ev.description,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          location: ev.location,
          inviteToken: inv.token
        })
        await sendEmail({ to: inv.email!, subject: `You're invited — ${ev.title}`, html, text, tag: 'event-invite' })
      })
      sent += 1
    }

    if (ev.startsAt) {
      const reminderTs = new Date(ev.startsAt).getTime() - 2 * DAY_MS
      if (reminderTs > Date.now()) {
        await step.sendEvent('schedule-reminder', {
          name: 'events/event.reminder',
          data: { eventId: ev.id },
          ts: reminderTs
        })
      }
    }

    return { sent }
  }
)
