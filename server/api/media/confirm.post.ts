import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { isR2Configured } from '#server/utils/r2'
import { resolveMediaActor } from '#server/utils/media'
import { media } from '#server/database/schema'

const bodySchema = z.object({
  eventSlug: z.string().min(1).max(200).optional().nullable(),
  rsvpToken: z.string().min(1).max(200).optional().nullable(),
  mediaId: z.string().min(1).max(50),
  caption: z.string().max(2000).optional().nullable(),
  takenAt: z.iso.datetime({ offset: true }).optional().nullable()
})

/**
 * Finalise an upload. The browser calls this after successfully PUTting
 * the bytes to R2. We flip the row from `pending` to `ready` and attach
 * optional metadata (caption, takenAt).
 *
 * Callers must identify themselves with the same auth context that
 * created the pending row (planner session or RSVP token), and the row
 * must belong to their event — guests cannot confirm a different guest's
 * upload even if they know the id.
 */
export default defineEventHandler(async (e) => {
  if (!isR2Configured()) {
    throw createError({ statusCode: 501, message: 'Object storage is not configured on this instance' })
  }

  const body = await readValidatedBody(e, bodySchema.parse)
  const actor = await resolveMediaActor(e, {
    eventSlug: body.eventSlug,
    rsvpToken: body.rsvpToken
  })

  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, body.mediaId), eq(media.eventId, actor.eventId)))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Upload not found' })
  }
  // Guests can only confirm their own pending uploads.
  if (actor.kind === 'guest' && row.uploadedByRsvpId !== actor.rsvpId) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const [updated] = await db
    .update(media)
    .set({
      status: 'ready',
      caption: body.caption ?? row.caption,
      takenAt: body.takenAt ? new Date(body.takenAt) : row.takenAt
    })
    .where(eq(media.id, row.id))
    .returning()

  return { media: updated }
})
