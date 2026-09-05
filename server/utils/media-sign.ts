import { createObjectStore, isStorageConfigured } from './storage'
import type { MediaItemView } from '../domain/index'

/**
 * zäme's half of the media seam: core hands back storage keys, this signs a
 * short-lived download URL per item with the app's object store. Signing is
 * local (SigV4) — no network round-trip per item.
 */

export type SignedMediaItem = MediaItemView & { url: string }

export function assertStorageConfigured(): void {
  if (!isStorageConfigured()) {
    throw createError({ statusCode: 501, message: 'Object storage is not configured on this instance' })
  }
}

export async function signMediaItems(items: MediaItemView[]): Promise<SignedMediaItem[]> {
  if (items.length === 0) return []
  assertStorageConfigured()
  const store = createObjectStore()
  return Promise.all(items.map(async item => ({
    ...item,
    url: await store.presignDownload(item.storageKey)
  })))
}
