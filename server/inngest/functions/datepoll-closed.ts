import { asc, eq } from 'drizzle-orm'
import { inngest, DatePollClosedEvent, dispatch } from '../client'
import { db } from '#server/utils/db'
import { datePoll, datePollResponse, datePollSlot } from '#server/database/schema'

/**
 * Auto-close a date poll when its deadline passes. The function is fired
 * with `ts: deadline` from the planner-create endpoint, so Inngest delivers
 * it at exactly the right moment.
 *
 * If the planner already decided the poll manually, this is a no-op.
 * Otherwise we pick the slot with the highest weighted score (yes=1,
 * if_need_be=0.5, no=0), with deterministic tie-breaks (earliest
 * `startsAt`, then earliest `sortOrder`), close the poll, and dispatch
 * `datepoll.decided` so attendees get their notification.
 *
 * The decision is "auto" — we promote the slot onto the event but do not
 * flip it to `published`. A planner can still review the responses and
 * publish manually.
 */
export const datePollClosed = inngest.createFunction(
  {
    id: 'datepoll-closed',
    name: 'Auto-close date poll at deadline',
    triggers: [{ event: DatePollClosedEvent }]
  },
  async ({ event: evt, step }) => {
    const { pollId } = evt.data

    const poll = await step.run('load-poll', async () => {
      const [row] = await db.select().from(datePoll).where(eq(datePoll.id, pollId)).limit(1)
      return row ?? null
    })

    if (!poll) return { skipped: 'poll-not-found' }
    if (poll.closedAt) return { skipped: 'already-closed' }

    // Don't pre-empt a planner who hasn't finalised their deadline.
    // Step return values are serialised — re-hydrate any Date fields.
    if (poll.deadline && new Date(poll.deadline).getTime() > Date.now() + 60_000) {
      return { skipped: 'deadline-changed' }
    }

    const slots = await step.run('load-slots', async () => {
      return db
        .select()
        .from(datePollSlot)
        .where(eq(datePollSlot.pollId, poll.id))
        .orderBy(asc(datePollSlot.sortOrder), asc(datePollSlot.startsAt))
    })
    if (slots.length === 0) {
      // Nothing to decide — just close.
      await step.run('close-empty', async () =>
        db.update(datePoll).set({ closedAt: new Date() }).where(eq(datePoll.id, poll.id))
      )
      return { closed: true, decidedSlotId: null }
    }

    const responses = await step.run('load-responses', async () => {
      return db
        .select({ slotId: datePollResponse.slotId, response: datePollResponse.response })
        .from(datePollResponse)
        .where(eq(datePollResponse.pollId, poll.id))
    })

    const score = new Map<string, number>()
    for (const r of responses) {
      const v = r.response === 'yes' ? 1 : r.response === 'if_need_be' ? 0.5 : 0
      score.set(r.slotId, (score.get(r.slotId) ?? 0) + v)
    }

    // Tie-break: highest score → earliest start → existing sort order.
    let best = slots[0]!
    let bestScore = score.get(best.id) ?? 0
    let bestStartMs = new Date(best.startsAt).getTime()
    for (const s of slots.slice(1)) {
      const sc = score.get(s.id) ?? 0
      const sMs = new Date(s.startsAt).getTime()
      if (sc > bestScore
        || (sc === bestScore && sMs < bestStartMs)
        || (sc === bestScore && sMs === bestStartMs && s.sortOrder < best.sortOrder)
      ) {
        best = s
        bestScore = sc
        bestStartMs = sMs
      }
    }

    const startsAt = new Date(best.startsAt)
    const endsAt = best.endsAt
      ? new Date(best.endsAt)
      : new Date(startsAt.getTime() + 2 * 60 * 60 * 1000)

    await step.run('close-poll', async () => {
      const { event: eventTbl } = await import('#server/database/schema')
      await db.transaction(async (tx) => {
        await tx
          .update(datePoll)
          .set({ decidedSlotId: best.id, closedAt: new Date() })
          .where(eq(datePoll.id, poll.id))
        await tx
          .update(eventTbl)
          .set({ startsAt, endsAt })
          .where(eq(eventTbl.id, poll.eventId))
      })
    })

    await step.run('dispatch-decided', async () => {
      await dispatch('datepoll.decided', { pollId: poll.id, eventId: poll.eventId })
    })

    return { closed: true, decidedSlotId: best.id, score: bestScore }
  }
)
