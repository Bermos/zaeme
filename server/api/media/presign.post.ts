import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { buildMediaKey, isR2Configured, presignUpload } from '#server/utils/r2'
import { MEDIA_TYPE_MAX_BYTES, MEDIA_TYPE_MIME, resolveMediaActor } from '#server/utils/media'
import { media } from '#server/database/schema'

const bodySchema = z.object({
  // Planner uploads identify the event by slug; guest uploads by invite token.
  eventSlug: z.string().min(1).max(200).optional().nullable(),
  rsvpToken: z.string().min(1).max(200).optional().nullable(),
  type: z.enum(['photo', 'video', 'document', 'ticket']),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024) // 1 GiB hard cap
})

export default defineEventHandler(async (e) => {
  if (!isR2Configured()) {
    throw createError({ statusCode: 501, message: 'Object storage is not configured on this instance' })
  }

  const body = await readValidatedBody(e, bodySchema.parse)

  // Validate MIME + size per media type before spending a round-trip with R2.
  if (!MEDIA_TYPE_MIME[body.type].test(body.mimeType)) {
    throw createError({ statusCode: 422, message: `MIME type ${body.mimeType} not allowed for ${body.type}` })
  }
  if (body.sizeBytes > MEDIA_TYPE_MAX_BYTES[body.type]) {
    throw createError({
      statusCode: 413,
      message: `File exceeds the ${Math.round(MEDIA_TYPE_MAX_BYTES[body.type] / (1024 * 1024))} MB limit for ${body.type}`
    })
  }

  // Only planners can upload tickets (they assign them to specific guests).
  const actor = await resolveMediaActor(e, {
    eventSlug: body.eventSlug,
    rsvpToken: body.rsvpToken,
    forUpload: true
  })
  if (body.type === 'ticket' && actor.kind !== 'planner') {
    throw createError({ statusCode: 403, message: 'Only planners can upload tickets' })
  }

  const mediaId = createId()
  const storageKey = buildMediaKey(actor.eventId, body.type, mediaId, body.fileName)

  // Record a pending row up-front so the confirm call can verify it.
  await db.insert(media).values({
    id: mediaId,
    eventId: actor.eventId,
    type: body.type,
    status: 'pending',
    storageKey,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes,
    fileName: body.fileName,
    uploadedByUserId: actor.kind === 'planner' ? actor.userId : (actor.userId ?? null),
    uploadedByRsvpId: actor.rsvpId
  })

  const signed = await presignUpload(storageKey, body.mimeType, body.sizeBytes)

  return {
    mediaId,
    storageKey,
    upload: signed
  }
})
