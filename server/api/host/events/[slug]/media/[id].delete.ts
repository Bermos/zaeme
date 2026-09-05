import { deleteMedia } from '../../../../../domain/index'
import { createObjectStore, isStorageConfigured } from '../../../../../utils/storage'
import { requireGuestUser } from '../../../../../utils/auth'

/** Delete a media item (planner only) — row first, then the stored object. */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!

  const { storageKey } = await deleteMedia(user.id, slug, id)
  if (isStorageConfigured()) {
    // Best-effort: an orphaned object is harmless; a dangling row is not.
    await createObjectStore().delete(storageKey).catch((err) => {
      console.error('[zaeme:media] object delete failed', { storageKey, err })
    })
  }
  return { removed: true }
})
