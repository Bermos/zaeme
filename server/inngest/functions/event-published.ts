import * as React from 'react'
import { eq, isNotNull, and } from 'drizzle-orm'
import { inngest, EventPublishedEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEmail } from '#server/emails/render'
import { InviteEmail } from '#server/emails/invite'
import { event, invite, eventPlanner, user } from '#server/database/schema'

/**
 * Send invite emails to every *targeted* invite on the event that has an
 * email address set. Shareable (email-less) invites are skipped — they are
 * distributed out-of-band.
 *
 * Also schedules the 48-hour reminder job when the event has a `startsAt`.
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
      const [row] = await db
        .select()
        .from(event)
        .where(eq(event.id, eventId))
        .limit(1)
      return row ?? null
    })

    if (!ev) return { skipped: 'event-not-found' }

    const invites = await step.run('load-invites', async () => {
      return db
        .select()
        .from(invite)
        .where(and(eq(invite.eventId, ev.id), isNotNull(invite.email)))
    })

    const host = await step.run('load-owner', async () => {
      const [row] = await db
        .select({ name: user.name })
        .from(eventPlanner)
        .innerJoin(user, eq(eventPlanner.userId, user.id))
        .where(and(eq(eventPlanner.eventId, ev.id), eq(eventPlanner.role, 'owner')))
        .limit(1)
      return row?.name ?? null
    })

    let sent = 0
    for (const inv of invites) {
      if (inv.revokedAt) continue
      if (!inv.email) continue
      await step.run(`send-${inv.id}`, async () => {
        const { html, text } = await renderEmail(
          React.createElement(InviteEmail, {
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
        )
        await sendEmail({
          to: inv.email!,
          subject: `You're invited — ${ev.title}`,
          html,
          text,
          tag: 'event-invite'
        })
      })
      sent += 1
    }

    // Schedule the 48h reminder.
    if (ev.startsAt) {
      const reminderTs = new Date(ev.startsAt).getTime() - 48 * 60 * 60 * 1000
      if (reminderTs > Date.now()) {
        await step.sendEvent('schedule-reminder', {
          name: 'event.reminder',
          data: { eventId: ev.id },
          ts: reminderTs
        })
      }
    }

    return { sent }
  }
)
