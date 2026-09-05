import { z } from 'zod'
import { mediaLibrary } from '../../domain/index'
import { requireOwner } from '../../utils/admin'
import { isStorageConfigured, createObjectStore } from '../../utils/storage'

/**
 * The media library across every event.
 *
 * Download URLs are presigned per item, which is local SigV4 arithmetic and not
 * a network call — but it is still per item, so the page size is bounded by the
 * domain function rather than by the client. With no object store configured
 * the metadata is still worth showing, so the items come back without URLs
 * instead of the whole page 501-ing.
 */
const querySchema = z.object({
  type: z.enum(['photo', 'video', 'document', 'ticket']).optional(),
  eventSlug: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional()
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const page = await mediaLibrary(await getValidatedQuery(e, querySchema.parse))

  if (!isStorageConfigured()) {
    return { ...page, storageConfigured: false, items: page.items.map(i => ({ ...i, url: null })) }
  }

  const store = createObjectStore()
  const items = await Promise.all(page.items.map(async i => ({ ...i, url: await store.presignDownload(i.storageKey) })))
  return { ...page, storageConfigured: true, items }
})
