import * as React from 'react'
import { eq } from 'drizzle-orm'
import { inngest, DatePollDecidedEvent } from '../client'
import { db } from '#server/utils/db'
import { sendEmail } from '#server/utils/email'
import { renderEmail } from '#server/emails/render'
import { renderEventIcs } from '#server/utils/ics'
import { DatePollDecidedEmail } from '#server/emails/date-poll-decided'
import { datePoll, datePollResponse, event, invite, user } from '#server/database/schema'

/**
 * Notify everyone who voted on the poll that a date has been picked.
 * Each recipient gets a `.ics` for the chosen slot so the date drops
 * into their calendar.
 *
 * We dedupe by (userId | guestEmail) so a respondent who voted on five
 * slots only receives one decision email.
 */
export const datePollDecided = inngest.createFunction(
  {
    id: 'datepoll-decided',
    name: 'Send date-poll decision',
    triggers: [{ event: DatePollDecidedEvent }]
  },
  async ({ event: evt, step }) => {
    const { pollId, eventId } = evt.data

    const poll = await step.run('load-poll', async () => {
      const [row] = await db.select().from(datePoll).where(eq(datePoll.id, pollId)).limit(1)
      return row ?? null
    })
    if (!poll) return { skipped: 'poll-not-found' }
    if (!poll.decidedSlotId) return { skipped: 'no-decision' }

    const ev = await step.run('load-event', async () => {
      const [row] = await db.select().from(event).where(eq(event.id, eventId)).limit(1)
      return row ?? null
    })
    if (!ev) return { skipped: 'event-not-found' }
    if (!ev.startsAt) return { skipped: 'no-start' }

    const respondents = await step.run('load-respondents', async () => {
      return db
        .select({
          response: datePollResponse,
          user,
          invite
        })
        .from(datePollResponse)
        .leftJoin(user, eq(datePollResponse.userId, user.id))
        .leftJoin(invite, eq(datePollResponse.inviteId, invite.id))
        .where(eq(datePollResponse.pollId, poll.id))
    })

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
    const attachments = [{
      filename: `${ev.slug}.ics`,
      content: ics,
      contentType: 'text/calendar; charset=utf-8; method=PUBLISH'
    }]

    let sent = 0
    const seen = new Set<string>()
    for (const r of respondents) {
      const to = r.user?.email ?? r.response.guestEmail
      if (!to) continue
      const key = to.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const recipientName = r.user?.name ?? r.response.guestName ?? null
      const inviteToken = r.invite?.token ?? null
      await step.run(`send-${r.response.id}`, async () => {
        const { html, text } = await renderEmail(
          React.createElement(DatePollDecidedEmail, {
            recipientName,
            eventTitle: ev.title,
            eventSlug: ev.slug,
            startsAt: ev.startsAt!,
            endsAt: ev.endsAt,
            location: ev.location,
            inviteToken
          })
        )
        await sendEmail({
          to,
          subject: `Date confirmed — ${ev.title}`,
          html,
          text,
          tag: 'datepoll-decided',
          attachments
        })
      })
      sent += 1
    }

    return { sent }
  }
)
