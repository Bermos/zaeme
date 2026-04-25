import * as React from 'react'
import { and, asc, eq, isNotNull } from 'drizzle-orm'
import { inngest, DatePollInviteEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEmail } from '#server/emails/render'
import { DatePollInviteEmail } from '#server/emails/date-poll-invite'
import { datePoll, datePollSlot, event, eventPlanner, invite, user } from '#server/database/schema'

/**
 * Fan out the "vote on a date" email to every targeted invite on the
 * event. Mirrors `eventPublished` — shareable invites (no email) are
 * skipped because they're distributed out-of-band.
 */
export const datePollInvite = inngest.createFunction(
  {
    id: 'datepoll-invite',
    name: 'Send date-poll invite emails',
    triggers: [{ event: DatePollInviteEvent }]
  },
  async ({ event: evt, step }) => {
    const { eventId } = evt.data

    const ev = await step.run('load-event', async () => {
      const [row] = await db.select().from(event).where(eq(event.id, eventId)).limit(1)
      return row ?? null
    })
    if (!ev) return { skipped: 'event-not-found' }

    const poll = await step.run('load-poll', async () => {
      const [row] = await db.select().from(datePoll).where(eq(datePoll.eventId, ev.id)).limit(1)
      return row ?? null
    })
    if (!poll) return { skipped: 'poll-not-found' }
    if (poll.closedAt) return { skipped: 'poll-closed' }

    const slots = await step.run('load-slots', async () => {
      return db
        .select({ startsAt: datePollSlot.startsAt, endsAt: datePollSlot.endsAt })
        .from(datePollSlot)
        .where(eq(datePollSlot.pollId, poll.id))
        .orderBy(asc(datePollSlot.sortOrder), asc(datePollSlot.startsAt))
    })

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
          React.createElement(DatePollInviteEmail, {
            recipientName: inv.name,
            hostName: host,
            eventTitle: ev.title,
            question: poll.question,
            slots,
            deadline: poll.deadline,
            inviteToken: inv.token
          })
        )
        await sendEmail({
          to: inv.email!,
          subject: `Help pick a date — ${ev.title}`,
          html,
          text,
          tag: 'datepoll-invite'
        })
      })
      sent += 1
    }

    return { sent }
  }
)
