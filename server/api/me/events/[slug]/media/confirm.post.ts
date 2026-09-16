import { z } from 'zod'
import { confirmReceiptPhotoAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { assertStorageConfigured } from '#server/utils/media-sign'

/**
 * Two-step upload, step 2, for a signed-in participant: the bytes are in the
 * bucket, mark the row `ready` (#29). Until this runs the row is `pending` and
 * `pinReceipt` refuses it, so a browser that uploads and then closes leaves
 * nothing a budget can point at.
 */
const bodySchema = z.object({
  mediaId: z.string().min(1).max(50),
  caption: z.string().max(2000).optional().nullable(),
  takenAt: z.string().optional().nullable()
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await confirmReceiptPhotoAsParticipant(user, slug, body.mediaId, {
    caption: body.caption,
    takenAt: body.takenAt
  })
  return { media }
})
