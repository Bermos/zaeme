import { z } from 'zod'
import { addReceiptPhotoAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { createObjectStore } from '#server/utils/storage'
import { assertStorageConfigured } from '#server/utils/media-sign'

/**
 * Two-step upload, step 1, for a SIGNED-IN PARTICIPANT (#29).
 *
 * This is the upload half of the receipt shortcut — "photograph it and pin it"
 * in one action from the expense row — and it exists because the two upload
 * paths that already existed cannot serve it. `/api/invites/{token}/media/
 * presign` wants a guest name, a guest email and an RSVP row, none of which a
 * session has to hand; `/api/host/events/{slug}/media/presign` is planner-only,
 * and a friend splitting an Airbnb is not a planner.
 *
 * IT WIDENS NOTHING. A participant is by definition somebody who already holds
 * the invite link's capability to add to this gallery, and `photo` is the
 * narrower of the two types that path accepts. The papers — `document` and
 * `ticket` — stay host-managed exactly as they were, which is why this enum has
 * one value rather than four: a receipt is a photograph, and anything else on
 * this surface would be a new capability nobody asked for.
 *
 * The MIME and size policy is the domain's (`MEDIA_TYPE_MIME`,
 * `MEDIA_TYPE_MAX_BYTES`): `image/*` up to 25 MB, refused 422 and 413
 * respectively. The `sizeBytes` bound below is a different thing — a sanity
 * limit on the NUMBER, so a preposterous one is a 400 before it reaches a
 * policy that would only say the same.
 */
const bodySchema = z.object({
  type: z.literal('photo'),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024)
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const { mediaId, storageKey } = await addReceiptPhotoAsParticipant(user, slug, {
    fileName: body.fileName,
    mimeType: body.mimeType,
    sizeBytes: body.sizeBytes
  })
  const upload = await createObjectStore().presignUpload(storageKey, body.mimeType, body.sizeBytes)
  return { mediaId, storageKey, upload }
})
