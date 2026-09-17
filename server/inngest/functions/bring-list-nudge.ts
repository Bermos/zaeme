import { inngest, BringListNudgeEvent } from '../client'
import { bringListNudgeDecision, loadBringListNudge } from '../../domain/contributions'
import { renderBringListNudgeEmail, sendEmail } from '../../emails/index'
import { emailConfigured } from '../../utils/mail-status'

/**
 * NUDGE THE UNCLAIMED DISHES THE NIGHT BEFORE (#46).
 *
 * Scheduled by `event.published` for 18:00 on the event's own wall clock the
 * day before it (`bringListNudgeAt`), and delivered here as an ordinary signal
 * with a future `ts` — the same mechanism the 48h reminder uses. Everything it
 * decides on is re-read when it lands; the signal carries an event id alone.
 *
 * ── "CANCELLING THE EVENT CANCELS THE NUDGE", AND HOW IT ACTUALLY WORKS ────
 *
 * It is worth being exact about this, because the obvious reading of the
 * neighbouring code is wrong. `eventReminder` has no `cancelOn` and no
 * `sleepUntil`; `eventCancelled` does nothing about the reminder already in
 * flight; and Inngest's `cancelOn` could not help either way, because it
 * cancels a RUN IN PROGRESS and a signal queued with a future `ts` has no run
 * to cancel until it is delivered. So NOTHING cancels the delivery, of the
 * reminder or of this. What stops the mail going out is that the function
 * re-reads the event and bails — `status !== 'published'`, which in the
 * reminder is written inline and here is the first rung of
 * `bringListNudgeDecision`.
 *
 * That distinction is the whole reason this file states it: copying the
 * reminder's TRIGGER shape without copying its re-read would have left a
 * cancelled party sending its guests a shopping list, with a green test suite
 * and an acceptance criterion that reads as met. The re-read is the mechanism,
 * not a formality, and `test/bring-list-nudge.test.ts` executes every rung of
 * the ladder including that one.
 *
 * ── ONCE PER EVENT, NOT A CAMPAIGN ────────────────────────────────────────
 *
 * Structurally, and not by a dedupe key: `events/event.published` is dispatched
 * by `setEventStatus` on the transition INTO `published`, and `published` can
 * be reached at most once in an event's life — `STATUS_TRANSITIONS`
 * (`server/domain/events-data.ts`) lets only `draft` and `polling` reach it,
 * and the only ways out of `published` are `completed` and `cancelled`, both of
 * which are terminal. One publish, one scheduled nudge, one mail each. That
 * invariant is asserted in `test/bring-list-nudge.test.ts` over the transition
 * table itself, so a sixth status that re-opened the cycle would fail there
 * rather than turn this into a campaign in production.
 *
 * ── AND WHERE PUSH GOES ───────────────────────────────────────────────────
 *
 * #42 and #43 are the push subscription and the send; neither exists yet, and
 * this issue is deliberately not blocked on them. When they land, the push goes
 * beside the `sendEmail` below, over the same `plan.recipients` and the same
 * `plan.gaps` — the decision of whether to nudge at all, and of what to say, is
 * already made above and is transport-independent.
 */
export const bringListNudge = inngest.createFunction(
  {
    id: 'bring-list-nudge',
    name: 'Nudge the unclaimed bring list',
    triggers: [{ event: BringListNudgeEvent }]
  },
  async ({ event: evt, step }) => {
    const { eventId } = evt.data

    const plan = await step.run('load-plan', () => loadBringListNudge(eventId))
    if (!plan) return { skipped: 'event-not-found', gaps: 0, recipients: 0 }

    // EVERY REASON NOT TO SEND IS IN `bringListNudgeDecision`, including the
    // cancellation check and the mail transport, and every one of them is
    // executed by `test/bring-list-nudge.test.ts`. A refusal written inline
    // here would be reachable by no test in this repository.
    const decision = bringListNudgeDecision(plan, {
      now: Date.now(),
      mailConfigured: emailConfigured()
    })
    if (!decision.send) {
      return { skipped: decision.reason, gaps: decision.gaps, recipients: decision.recipients }
    }

    let sent = 0
    for (const r of plan.recipients) {
      await step.run(`send-${r.rsvpId}`, async () => {
        const { html, text } = await renderBringListNudgeEmail({
          recipientName: r.name,
          eventTitle: plan.title,
          eventSlug: plan.slug,
          startsAt: plan.startsAt,
          endsAt: plan.endsAt,
          timezone: plan.timezone,
          location: plan.location,
          gaps: plan.gaps,
          inviteToken: r.inviteToken
        })
        await sendEmail({
          to: r.email,
          subject: `Still to bring — ${plan.title}`,
          html,
          text,
          tag: 'bring-list-nudge'
        })
      })
      sent += 1
    }

    // A PUSH SEND GOES HERE, once #42/#43 exist. See the note above.

    return { sent, gaps: plan.gaps.length }
  }
)
