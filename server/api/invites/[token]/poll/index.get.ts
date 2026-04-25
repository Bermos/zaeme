import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { resolveInviteToken } from '#server/utils/invite'
import { datePoll, datePollResponse, datePollSlot } from '#server/database/schema'

/**
 * Public poll view rendered to invitees. Returns the slot list, the
 * caller's existing responses (so they can edit), and aggregate counts
 * (without revealing per-respondent identities).
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { invite: inv, event: ev } = await resolveInviteToken(token)

  const [poll] = await db
    .select()
    .from(datePoll)
    .where(eq(datePoll.eventId, ev.id))
    .limit(1)

  if (!poll) return { poll: null }

  const slots = await db
    .select()
    .from(datePollSlot)
    .where(eq(datePollSlot.pollId, poll.id))
    .orderBy(asc(datePollSlot.sortOrder), asc(datePollSlot.startsAt))

  const slotIds = slots.map(s => s.id)
  const allResponses = slotIds.length > 0
    ? await db
        .select()
        .from(datePollResponse)
        .where(and(eq(datePollResponse.pollId, poll.id), inArray(datePollResponse.slotId, slotIds)))
    : []

  // Aggregate counts for everyone — visible to all invitees so they can
  // see momentum without a planner-only round-trip.
  const counts = new Map<string, { yes: number, ifNeedBe: number, no: number }>()
  for (const r of allResponses) {
    const b = counts.get(r.slotId) ?? { yes: 0, ifNeedBe: 0, no: 0 }
    if (r.response === 'yes') b.yes += 1
    else if (r.response === 'if_need_be') b.ifNeedBe += 1
    else b.no += 1
    counts.set(r.slotId, b)
  }

  // The caller's own responses, used to pre-fill the form. Keyed by
  // either userId (registered) or guestEmail (guest invite).
  const session = await optionalAuth(e)
  let myResponses: typeof datePollResponse.$inferSelect[] = []
  if (slotIds.length > 0) {
    if (session?.user) {
      myResponses = await db
        .select()
        .from(datePollResponse)
        .where(and(
          inArray(datePollResponse.slotId, slotIds),
          or(
            eq(datePollResponse.userId, session.user.id),
            eq(datePollResponse.guestEmail, session.user.email)
          )!
        ))
    } else if (inv.email) {
      myResponses = await db
        .select()
        .from(datePollResponse)
        .where(and(
          inArray(datePollResponse.slotId, slotIds),
          eq(datePollResponse.guestEmail, inv.email)
        ))
    }
  }

  return {
    poll: {
      id: poll.id,
      question: poll.question,
      deadline: poll.deadline,
      decidedSlotId: poll.decidedSlotId,
      closedAt: poll.closedAt,
      slots: slots.map((s) => {
        const c = counts.get(s.id) ?? { yes: 0, ifNeedBe: 0, no: 0 }
        return {
          id: s.id,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          counts: c
        }
      }),
      myResponses: myResponses.map(r => ({ slotId: r.slotId, response: r.response }))
    }
  }
})
