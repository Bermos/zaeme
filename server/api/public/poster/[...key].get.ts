import { createObjectStore } from '../../../utils/storage'
import { isPublicPosterKey } from '../../../domain/index'
import { assertStorageConfigured } from '../../../utils/media-sign'

/**
 * Serve the poster art of a PUBLIC event (ADR-0033 §4) — the concert flyer the
 * owner uploaded in Enterprise, so the zäme listing and the event page have a
 * picture without anyone re-uploading it.
 *
 * Open by design: the image belongs to an event that has been published to the
 * world. Authorisation is re-derived per request from the events domain
 * (`isPublicPosterKey`) rather than trusted from the URL — unpublish the concert
 * and the poster stops resolving, with nothing else to revoke.
 *
 * The bytes are relayed rather than redirected: a presigned URL expires, and this
 * URL is persisted on the event row and served into `<img src>` and OG cards.
 */
export default defineEventHandler(async (e) => {
  const key = (getRouterParam(e, 'key') || '').split('/').map(decodeURIComponent).join('/')
  if (!key) throw createError({ statusCode: 400, message: 'Missing poster key' })

  if (!await isPublicPosterKey(key)) {
    throw createError({ statusCode: 404, message: 'No public poster for that key' })
  }

  assertStorageConfigured()
  const signed = await createObjectStore().presignDownload(key)
  const res = await fetch(signed)
  if (!res.ok || !res.body) {
    throw createError({ statusCode: 502, message: `Poster unavailable (${res.status})` })
  }

  setHeader(e, 'content-type', res.headers.get('content-type') || 'application/octet-stream')
  // Public, immutable art: cache hard at the edge and in the browser.
  setHeader(e, 'cache-control', 'public, max-age=3600, s-maxage=86400')
  return res.body
})
