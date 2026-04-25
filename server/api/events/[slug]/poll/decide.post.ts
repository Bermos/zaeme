import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { dispatch } from '#server/inngest/client'
import { datePoll, datePollSlot, event } from '#server/database/schema'

const bodySchema = z.object({
  slotId: z.string().min(1),
  /**
   * If true, also flip the event from `polling` → `published` and fan out
   * invite emails. Default true — that's the canonical happy path.
   */
  publish: z.boolean().optional().default(true)
})

/**
 * Close a date poll on a winning slot. Side effects:
 *   1. Mark the poll closed and record `decidedSlotId`.
 *   2. Promote the slot's `startsAt`/`endsAt` onto the event row (defaulting
 *      `endsAt` to +2h when the slot is open-ended).
 *   3. (Optionally) transition the event from `polling` to `published` and
 *      fire `event.published` so invite emails go out.
 *   4. Fire `datepoll.decided` so respondents get a "the date is set"
 *      email with the new `.ics` attachment.
 */
export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

  const body = await readValidatedBody(e, bodySchema.parse)

  const [poll] = await db
    .select()
    .from(datePoll)
    .where(eq(datePoll.eventId, ev.id))
    .limit(1)
  if (!poll) throw createError({ statusCode: 404, message: 'No poll for this event' })
  if (poll.closedAt) {
    throw createError({ statusCode: 422, message: 'Poll is already closed' })
  }

  const [slot] = await db
    .select()
    .from(datePollSlot)
    .where(and(eq(datePollSlot.id, body.slotId), eq(datePollSlot.pollId, poll.id)))
    .limit(1)
  if (!slot) throw createError({ statusCode: 404, message: 'Slot not found' })

  const startsAt = slot.startsAt
  const endsAt = slot.endsAt ?? new Date(startsAt.getTime() + 2 * 60 * 60 * 1000)

  const willPublish = body.publish && (ev.status === 'polling' || ev.status === 'draft')

  await db.transaction(async (tx) => {
    await tx
      .update(datePoll)
      .set({ decidedSlotId: slot.id, closedAt: new Date() })
      .where(eq(datePoll.id, poll.id))

    await tx
      .update(event)
      .set({
        startsAt,
        endsAt,
        ...(willPublish ? { status: 'published' as const } : {})
      })
      .where(eq(event.id, ev.id))
  })

  // Background notifications. Each `dispatch` call is fire-and-forget.
  await dispatch('datepoll.decided', { pollId: poll.id, eventId: ev.id })
  if (willPublish) {
    await dispatch('event.published', { eventId: ev.id })
  }

  return { success: true, decidedSlotId: slot.id, startsAt, endsAt, status: willPublish ? 'published' : ev.status }
})
