import { z } from 'zod'
import { createObjectStore } from '../../../../utils/storage'
import { guestRegisterMediaUpload } from '../../../../domain/index'
import { assertStorageConfigured } from '../../../../utils/media-sign'

/**
 * Two-step guest upload, step 1: photos/videos into the shared gallery (core
 * enforces the guests-can't-upload-papers rule and the MIME/size policy).
 */
const bodySchema = z.object({
  type: z.enum(['photo', 'video']),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const { mediaId, storageKey } = await guestRegisterMediaUpload(
    token,
    { type: body.type, fileName: body.fileName, mimeType: body.mimeType, sizeBytes: body.sizeBytes },
    { guestName: body.guestName, guestEmail: body.guestEmail }
  )
  const upload = await createObjectStore().presignUpload(storageKey, body.mimeType, body.sizeBytes)
  return { mediaId, storageKey, upload }
})
