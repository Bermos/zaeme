import { z } from 'zod'
import { guestConfirmMediaUpload } from '../../../../domain/index'
import { assertStorageConfigured } from '../../../../utils/media-sign'

/** Two-step guest upload, step 2: mark ready (only the uploader's own row). */
const bodySchema = z.object({
  mediaId: z.string().min(1).max(50),
  caption: z.string().max(2000).optional().nullable(),
  takenAt: z.string().optional().nullable(),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await guestConfirmMediaUpload(
    token,
    body.mediaId,
    { caption: body.caption, takenAt: body.takenAt },
    { guestName: body.guestName, guestEmail: body.guestEmail }
  )
  return { media }
})
