import { and, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { resolveInviteToken } from '#server/utils/invite'
import { datePoll, datePollResponse, datePollSlot } from '#server/database/schema'

const responseSchema = z.object({
  guestName: z.string().min(1).max(200).optional(),
  guestEmail: z.email().optional(),
  /**
   * Caller's vote per slot. The map's keys are slot IDs; values are the
   * three-way response. Slots not present in the map are treated as
   * unanswered and any prior response is removed.
   */
  responses: z.record(z.string().min(1), z.enum(['yes', 'if_need_be', 'no']))
})

/**
 * Submit (or update) a voter's responses on a poll. Identity is the
 * authenticated user when a session is present, otherwise the guest
 * pair derived from the invite (or supplied in the body).
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { invite: inv, event: ev } = await resolveInviteToken(token)
  const body = await readValidatedBody(e, responseSchema.parse)

  const [poll] = await db
    .select()
    .from(datePoll)
    .where(eq(datePoll.eventId, ev.id))
    .limit(1)
  if (!poll) throw createError({ statusCode: 404, message: 'No poll for this event' })
  if (poll.closedAt) {
    throw createError({ statusCode: 410, message: 'This poll is closed' })
  }
  if (poll.deadline && poll.deadline.getTime() < Date.now()) {
    throw createError({ statusCode: 410, message: 'This poll has passed its deadline' })
  }

  const slots = await db
    .select({ id: datePollSlot.id })
    .from(datePollSlot)
    .where(eq(datePollSlot.pollId, poll.id))
  const slotIds = new Set(slots.map(s => s.id))

  // Reject responses for slots that don't belong to this poll.
  for (const slotId of Object.keys(body.responses)) {
    if (!slotIds.has(slotId)) {
      throw createError({ statusCode: 422, message: `Unknown slot: ${slotId}` })
    }
  }

  // Identity resolution mirrors the RSVP route.
  const session = await optionalAuth(e)
  let userId: string | null = null
  let guestName: string | null = null
  let guestEmail: string | null = null

  if (session?.user) {
    userId = session.user.id
  } else {
    const name = body.guestName ?? inv.name ?? null
    const email = (body.guestEmail ?? inv.email ?? '').toLowerCase()
    if (!name || !email) {
      throw createError({ statusCode: 400, message: 'Guest votes require name and email' })
    }
    guestName = name
    guestEmail = email
  }

  const identityWhere = userId
    ? eq(datePollResponse.userId, userId)
    : eq(datePollResponse.guestEmail, guestEmail!)

  // Load existing rows for this voter on this poll so we can upsert.
  const existing = await db
    .select()
    .from(datePollResponse)
    .where(and(eq(datePollResponse.pollId, poll.id), identityWhere))
  const existingBySlot = new Map(existing.map(r => [r.slotId, r]))

  const now = new Date()
  await db.transaction(async (tx) => {
    // Delete responses that the caller cleared (slot not in `responses`).
    const submittedSlots = new Set(Object.keys(body.responses))
    const toDelete = existing.filter(r => !submittedSlots.has(r.slotId)).map(r => r.id)
    if (toDelete.length > 0) {
      await tx.delete(datePollResponse).where(inArray(datePollResponse.id, toDelete))
    }

    for (const [slotId, value] of Object.entries(body.responses)) {
      const existingRow = existingBySlot.get(slotId)
      if (existingRow) {
        await tx
          .update(datePollResponse)
          .set({
            response: value,
            inviteId: inv.id,
            ...(userId
              ? { userId, guestName: null, guestEmail: null }
              : { guestName, guestEmail }
            ),
            updatedAt: now
          })
          .where(eq(datePollResponse.id, existingRow.id))
      } else {
        await tx.insert(datePollResponse).values({
          id: createId(),
          pollId: poll.id,
          slotId,
          inviteId: inv.id,
          userId,
          guestName: userId ? null : guestName,
          guestEmail: userId ? null : guestEmail,
          response: value
        })
      }
    }
  })

  // Re-load the caller's responses so the client can re-render confidently.
  const updated = await db
    .select({ slotId: datePollResponse.slotId, response: datePollResponse.response })
    .from(datePollResponse)
    .where(and(eq(datePollResponse.pollId, poll.id), identityWhere))

  return { responses: updated }
})
