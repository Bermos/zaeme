import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { auth, consumePendingMagicLink } from '#server/utils/auth'
import { bumpInviteUsage, resolveInviteToken } from '#server/utils/invite'
import { rsvp } from '#server/database/schema'

const statusSchema = z.enum(['yes', 'maybe', 'no', 'cheering'])

const bodySchema = z.object({
  status: statusSchema,
  plusOne: z.boolean().optional().default(false),
  plusOneName: z.string().max(200).optional().nullable(),
  dietary: z.string().max(500).optional().nullable(),
  accessibility: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  guestName: z.string().min(1).max(200).optional(),
  guestEmail: z.email().optional()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { invite: inv, event: ev } = await resolveInviteToken(token)

  const body = await readValidatedBody(e, bodySchema.parse)

  if (body.status === 'cheering' && ev.type !== 'concert') {
    throw createError({ statusCode: 422, message: 'Cheering is only valid for concert events' })
  }

  const session = await optionalAuth(e)

  // Resolve the attendee identity
  let userId: string | null = null
  let guestName: string | null = null
  let guestEmail: string | null = null

  if (session?.user) {
    userId = session.user.id
  } else {
    if (!body.guestName || !body.guestEmail) {
      throw createError({ statusCode: 400, message: 'Guest RSVPs require name and email' })
    }
    guestName = body.guestName
    guestEmail = body.guestEmail.toLowerCase()
  }

  // Upsert RSVP (one per attendee per event)
  const whereClauses = userId
    ? and(eq(rsvp.eventId, ev.id), eq(rsvp.userId, userId))
    : and(eq(rsvp.eventId, ev.id), eq(rsvp.guestEmail, guestEmail!))

  const [existing] = await db.select().from(rsvp).where(whereClauses).limit(1)

  const values = {
    status: body.status,
    plusOne: body.plusOne ?? false,
    plusOneName: body.plusOne ? (body.plusOneName ?? null) : null,
    dietary: body.dietary ?? null,
    accessibility: body.accessibility ?? null,
    notes: body.notes ?? null
  }

  let saved: typeof rsvp.$inferSelect
  let isNew = false

  if (existing) {
    const [updated] = await db
      .update(rsvp)
      .set({
        ...values,
        // Refresh identity fields in case the guest changed their email/name
        ...(userId ? { userId } : { guestName, guestEmail })
      })
      .where(eq(rsvp.id, existing.id))
      .returning()
    saved = updated!
  } else {
    isNew = true
    const [inserted] = await db
      .insert(rsvp)
      .values({
        id: createId(),
        eventId: ev.id,
        inviteId: inv.id,
        userId,
        guestName,
        guestEmail,
        ...values
      })
      .returning()
    saved = inserted!
    await bumpInviteUsage(inv.id)
  }

  // For guests, generate a magic link so they can return pre-authenticated
  // to edit their RSVP. Email delivery lands in Phase 3; for now the URL
  // is logged server-side and surfaced in the response.
  let magicLinkUrl: string | null = null
  if (!session && guestEmail && isNew) {
    try {
      await auth.api.signInMagicLink({
        body: {
          email: guestEmail,
          name: guestName ?? undefined,
          callbackURL: `/invite/${inv.token}`
        },
        headers: e.headers
      })
      magicLinkUrl = consumePendingMagicLink(guestEmail)?.url ?? null
    } catch (err) {
      // Don't fail the RSVP if magic-link generation fails.
      console.error('[rsvp] magic-link generation failed', err)
    }
  }

  return { rsvp: saved, magicLinkUrl }
})
