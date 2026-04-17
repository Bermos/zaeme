import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { auth } from '#server/utils/auth'
import { db } from '#server/utils/db'
import { attendee, event, eventInvite } from '#server/database/schema'

const baseSchema = z.object({
  status: z.enum(['yes', 'maybe', 'no', 'cheering']),
  name: z.string().min(1).max(200).optional(),
  email: z.email().optional(),
  plusOne: z.number().int().min(0).max(1).optional(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  note: z.string().max(2000).optional().nullable()
})

/**
 * Create or update an RSVP via a public invite token.
 *
 * - If the caller has an authenticated session, name/email are taken from
 *   the user account and the RSVP is linked to their userId.
 * - Otherwise (guest) the body must include name + email.
 * - A unique (eventId, email) constraint makes the operation idempotent:
 *   repeated submissions update the existing RSVP rather than creating
 *   duplicates.
 * - Each attendee is assigned a personal `rsvpToken` that can be used to
 *   manage the RSVP later (magic-link style). The first RSVP returns this
 *   token; subsequent updates also return it.
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!

  const [row] = await db
    .select({
      invite: eventInvite,
      event: event
    })
    .from(eventInvite)
    .innerJoin(event, eq(eventInvite.eventId, event.id))
    .where(eq(eventInvite.token, token))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }

  const ev = row.event
  if (ev.status !== 'polling' && ev.status !== 'published') {
    throw createError({ statusCode: 422, message: 'Event is not open for RSVPs' })
  }

  // Enforce per-event RSVP type: concerts accept only `cheering`; other event
  // types accept yes/maybe/no.
  const body = await readValidatedBody(e, baseSchema.parse)
  if (ev.type === 'concert' && body.status !== 'cheering') {
    throw createError({ statusCode: 422, message: 'Concert RSVPs use "cheering"' })
  }
  if (ev.type !== 'concert' && body.status === 'cheering') {
    throw createError({ statusCode: 422, message: '"cheering" is only valid for concerts' })
  }

  const session = await auth.api.getSession({ headers: e.headers })

  let name: string | undefined
  let email: string | undefined
  let userId: string | null = null

  if (session?.user) {
    name = body.name?.trim() || session.user.name
    email = session.user.email
    userId = session.user.id
  } else {
    if (!body.name || !body.email) {
      throw createError({
        statusCode: 422,
        message: 'Guest RSVPs require both name and email'
      })
    }
    name = body.name.trim()
    email = body.email.trim().toLowerCase()
  }

  // Look up any existing RSVP for this (event, email) pair.
  const [existing] = await db
    .select()
    .from(attendee)
    .where(and(
      eq(attendee.eventId, ev.id),
      eq(attendee.email, email!)
    ))
    .limit(1)

  if (existing) {
    const updates: Record<string, unknown> = {
      name: name!,
      rsvpStatus: body.status,
      inviteId: row.invite.id,
      // Adopt the userId if the guest later authenticates with the same email.
      userId: userId ?? existing.userId
    }
    if (body.plusOne !== undefined) updates.plusOne = body.plusOne
    if (body.dietary !== undefined) updates.dietary = body.dietary
    if (body.accessibility !== undefined) updates.accessibility = body.accessibility
    if (body.note !== undefined) updates.note = body.note

    const [updated] = await db
      .update(attendee)
      .set(updates)
      .where(eq(attendee.id, existing.id))
      .returning()
    return updated
  }

  const [inserted] = await db
    .insert(attendee)
    .values({
      id: createId(),
      eventId: ev.id,
      userId,
      name: name!,
      email: email!,
      rsvpStatus: body.status,
      plusOne: body.plusOne ?? 0,
      dietary: body.dietary ?? null,
      accessibility: body.accessibility ?? null,
      note: body.note ?? null,
      inviteId: row.invite.id,
      rsvpToken: createId()
    })
    .returning()
  return inserted
})
