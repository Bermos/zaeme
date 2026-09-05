import { z } from 'zod'
import { createObjectStore } from '../../../../../utils/storage'
import { assertPlanner, loadEventBySlug, registerMediaUpload } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'
import { assertStorageConfigured } from '../../../../../utils/media-sign'

/**
 * Two-step host upload, step 1 (planner only). Hosts may upload every type —
 * gallery media plus the papers: documents (reservations) and tickets.
 */
const bodySchema = z.object({
  type: z.enum(['photo', 'video', 'document', 'ticket']),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024)
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, user.id, { roles: ['owner', 'co_planner'] })

  const { mediaId, storageKey } = await registerMediaUpload(ev.id, body, { userId: user.id })
  const upload = await createObjectStore().presignUpload(storageKey, body.mimeType, body.sizeBytes)
  return { mediaId, storageKey, upload }
})
