import { and, eq, isNotNull } from 'drizzle-orm'
import { inngest, EventPublishedEvent } from '../client'
import { tables, useDb } from '../../domain/db'
import { bringListNudgeAt } from '../../domain/contributions'
import { guestUser } from '../../database/schema/auth'
import { renderInviteEmail, sendEmail } from '../../emails/index'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Send the invite email to every *targeted* invite on the event — one with an
 * email address. Shareable (email-less) links are skipped: those are handed
 * out by the host out-of-band.
 *
 * Then schedule the two things that arrive later: the 48h reminder, if the
 * event starts more than 48h out, and the bring-list nudge (#46) at 18:00 the
 * evening before on the event's own clock. Both are ordinary signals with a
 * future `ts`, and both decide whether they have anything to say when they
 * land rather than now.
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
          timezone: ev.timezone,
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

    // THE BRING-LIST NUDGE (#46), and it is NOT the 48h offset again: it is
    // 18:00 the evening before ON THE EVENT'S OWN CLOCK, because a nudge to go
    // and buy bread is only useful while the shops are open. That is why this
    // is a separate calculation and not `startsAt - 24h` — see
    // `bringListNudgeAt`. Whether there is anything to nudge ABOUT is decided
    // when the signal lands and not now, because at publication the answer is
    // not yet knowable: the list is usually empty and nobody has had the link
    // long enough to claim anything on it.
    const nudgeTs = bringListNudgeAt(ev.startsAt, ev.timezone)?.getTime()
    if (nudgeTs && nudgeTs > Date.now()) {
      await step.sendEvent('schedule-bring-list-nudge', {
        name: 'events/bring-list.nudge',
        data: { eventId: ev.id },
        ts: nudgeTs
      })
    }

    return { sent }
  }
)
