import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { dispatch } from '#server/inngest/client'
import { datePoll, datePollResponse, datePollSlot, event } from '#server/database/schema'

/**
 * Aggregated slot row returned to planners. Score follows the spec:
 * yes=1, if_need_be=0.5, no=0 — same weighting as Doodle's "if need be".
 */
export interface SlotResultDto {
  id: string
  startsAt: string
  endsAt: string | null
  sortOrder: number
  yes: number
  ifNeedBe: number
  no: number
  score: number
}

const slotSchema = z.object({
  id: z.string().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional().nullable()
})

const createSchema = z.object({
  question: z.string().max(500).optional().nullable(),
  deadline: z.iso.datetime({ offset: true }).optional().nullable(),
  slots: z.array(slotSchema).min(1, 'At least one slot is required').max(50)
})

const patchSchema = z.object({
  question: z.string().max(500).optional().nullable(),
  deadline: z.iso.datetime({ offset: true }).optional().nullable(),
  slots: z.array(slotSchema).min(1).max(50).optional()
})

function tallyResponses(
  slots: { id: string, startsAt: Date, endsAt: Date | null, sortOrder: number }[],
  responses: { slotId: string, response: 'yes' | 'if_need_be' | 'no' }[]
): SlotResultDto[] {
  const buckets = new Map<string, { yes: number, ifNeedBe: number, no: number }>()
  for (const r of responses) {
    const b = buckets.get(r.slotId) ?? { yes: 0, ifNeedBe: 0, no: 0 }
    if (r.response === 'yes') b.yes += 1
    else if (r.response === 'if_need_be') b.ifNeedBe += 1
    else b.no += 1
    buckets.set(r.slotId, b)
  }
  return slots.map((s) => {
    const b = buckets.get(s.id) ?? { yes: 0, ifNeedBe: 0, no: 0 }
    return {
      id: s.id,
      startsAt: s.startsAt.toISOString(),
      endsAt: s.endsAt ? s.endsAt.toISOString() : null,
      sortOrder: s.sortOrder,
      yes: b.yes,
      ifNeedBe: b.ifNeedBe,
      no: b.no,
      score: b.yes + b.ifNeedBe * 0.5
    }
  })
}

function dedupeRespondents(rows: typeof datePollResponse.$inferSelect[]) {
  const seen = new Set<string>()
  const out: { id: string, name: string | null, email: string | null }[] = []
  for (const r of rows) {
    const key = r.userId ?? r.guestEmail ?? r.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: r.id, name: r.guestName, email: r.guestEmail })
  }
  return out
}

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const ev = await loadEventBySlug(slug)

  if (e.method === 'GET') {
    await assertPlanner(ev.id, session.user.id)
    return loadPollDto(ev.id)
  }

  if (e.method === 'POST') {
    await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

    if (ev.status !== 'draft' && ev.status !== 'polling') {
      throw createError({
        statusCode: 422,
        message: 'A poll can only be created while the event is in draft or polling status'
      })
    }

    const [existing] = await db
      .select()
      .from(datePoll)
      .where(eq(datePoll.eventId, ev.id))
      .limit(1)
    if (existing) {
      throw createError({ statusCode: 409, message: 'This event already has a poll' })
    }

    const body = await readValidatedBody(e, createSchema.parse)
    const pollId = createId()

    await db.transaction(async (tx) => {
      await tx.insert(datePoll).values({
        id: pollId,
        eventId: ev.id,
        question: body.question ?? null,
        deadline: body.deadline ? new Date(body.deadline) : null,
        createdByUserId: session.user.id
      })
      await tx.insert(datePollSlot).values(
        body.slots.map((s, idx) => ({
          id: createId(),
          pollId,
          startsAt: new Date(s.startsAt),
          endsAt: s.endsAt ? new Date(s.endsAt) : null,
          sortOrder: idx
        }))
      )
      // Auto-transition to polling so the public invite page renders the
      // poll instead of the inert RSVP form.
      if (ev.status === 'draft') {
        await tx
          .update(event)
          .set({ status: 'polling' })
          .where(eq(event.id, ev.id))
      }
    })

    // Schedule auto-close at the deadline. The job is idempotent — it
    // no-ops if the poll is already closed.
    if (body.deadline) {
      await dispatch('datepoll.closed', { pollId }, {
        ts: new Date(body.deadline).getTime()
      })
    }

    // Email targeted invitees so they can vote. Safe to call: the job
    // skips invites without an email (shareable links).
    await dispatch('datepoll.invite', { eventId: ev.id })

    return loadPollDto(ev.id)
  }

  if (e.method === 'PATCH') {
    await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

    const [poll] = await db
      .select()
      .from(datePoll)
      .where(eq(datePoll.eventId, ev.id))
      .limit(1)
    if (!poll) throw createError({ statusCode: 404, message: 'No poll for this event' })
    if (poll.closedAt) {
      throw createError({ statusCode: 422, message: 'Poll is closed and cannot be edited' })
    }

    const body = await readValidatedBody(e, patchSchema.parse)

    await db.transaction(async (tx) => {
      const updates: Partial<typeof datePoll.$inferInsert> = {}
      if (body.question !== undefined) updates.question = body.question
      if (body.deadline !== undefined) updates.deadline = body.deadline ? new Date(body.deadline) : null
      if (Object.keys(updates).length > 0) {
        await tx.update(datePoll).set(updates).where(eq(datePoll.id, poll.id))
      }

      if (body.slots) {
        // Reconcile slots: update those whose IDs reference an existing row,
        // insert new ones, delete the rest. Cascading FKs drop their
        // associated responses automatically.
        const existingSlots = await tx
          .select()
          .from(datePollSlot)
          .where(eq(datePollSlot.pollId, poll.id))
        const existingById = new Map(existingSlots.map(s => [s.id, s]))
        const keepIds = new Set(body.slots.map(s => s.id).filter((x): x is string => !!x))
        const toDelete = existingSlots.filter(s => !keepIds.has(s.id)).map(s => s.id)
        if (toDelete.length > 0) {
          await tx.delete(datePollSlot).where(inArray(datePollSlot.id, toDelete))
        }

        for (let i = 0; i < body.slots.length; i++) {
          const s = body.slots[i]!
          if (s.id && existingById.has(s.id)) {
            await tx
              .update(datePollSlot)
              .set({
                startsAt: new Date(s.startsAt),
                endsAt: s.endsAt ? new Date(s.endsAt) : null,
                sortOrder: i
              })
              .where(eq(datePollSlot.id, s.id))
          } else {
            await tx.insert(datePollSlot).values({
              id: createId(),
              pollId: poll.id,
              startsAt: new Date(s.startsAt),
              endsAt: s.endsAt ? new Date(s.endsAt) : null,
              sortOrder: i
            })
          }
        }
      }
    })

    if (body.deadline !== undefined && body.deadline) {
      await dispatch('datepoll.closed', { pollId: poll.id }, {
        ts: new Date(body.deadline).getTime()
      })
    }

    return loadPollDto(ev.id)
  }

  if (e.method === 'DELETE') {
    await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })
    await db.delete(datePoll).where(eq(datePoll.eventId, ev.id))
    return { success: true }
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})

/** Build the canonical poll-detail payload returned to the planner. */
async function loadPollDto(eventId: string) {
  const [poll] = await db
    .select()
    .from(datePoll)
    .where(eq(datePoll.eventId, eventId))
    .limit(1)

  if (!poll) return { poll: null as null }

  const slots = await db
    .select()
    .from(datePollSlot)
    .where(eq(datePollSlot.pollId, poll.id))
    .orderBy(asc(datePollSlot.sortOrder), asc(datePollSlot.startsAt))

  const responses = slots.length > 0
    ? await db
        .select()
        .from(datePollResponse)
        .where(and(
          eq(datePollResponse.pollId, poll.id),
          inArray(datePollResponse.slotId, slots.map(s => s.id))
        ))
        .orderBy(desc(datePollResponse.createdAt))
    : []

  return {
    poll: {
      id: poll.id,
      eventId: poll.eventId,
      question: poll.question,
      deadline: poll.deadline,
      decidedSlotId: poll.decidedSlotId,
      closedAt: poll.closedAt,
      createdAt: poll.createdAt,
      updatedAt: poll.updatedAt,
      slots: tallyResponses(slots, responses),
      respondents: dedupeRespondents(responses)
    }
  }
}
