import { createHash } from 'node:crypto'
import { isSha256Hex, posterObjectKey, publicPosterUrl } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { apiError } from '../../../../utils/api-v1'
import { publicUrl } from '../../../../utils/public-url'
import { createObjectStore, isStorageConfigured } from '../../../../utils/storage'

/**
 * `uploadPoster` — store poster bytes in zäme's own object store and hand back
 * the stable, non-expiring URL `publishConcert` carries.
 *
 * CONTENT-ADDRESSED, and the address is VERIFIED HERE. The digest in the path is
 * the client's claim; this route hashes the bytes it actually received and
 * refuses (422) on a mismatch. Trusting the client's digest would let one
 * caller's bytes be published under another's address — the object key is
 * derived from the digest, so the digest is a name, and a name nobody checks is
 * a way to overwrite someone else's.
 *
 * The bytes stay INERT until some public, published event's `posterUrl` points
 * at them: `/api/public/poster/**` re-derives that authorisation from the events
 * domain on every read, so unpublishing takes the image down with the
 * announcement and there is no second place to revoke.
 */

/** What zäme will serve as poster art, and how much of it. */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_POSTER_BYTES = 8 * 1024 * 1024

export default defineServiceHandler(async (event) => {
  const claimed = (getRouterParam(event, 'sha256') || '').toLowerCase()
  if (!isSha256Hex(claimed)) {
    throw apiError(422, 'validation_failed', 'The poster path must be a lowercase hex SHA-256.', { sha256: claimed })
  }

  const contentType = (getRequestHeader(event, 'content-type') || '').split(';')[0]!.trim().toLowerCase()
  if (!ALLOWED_TYPES.has(contentType)) {
    throw apiError(415, 'unsupported_media_type', `Poster art must be JPEG, PNG or WebP, not "${contentType || 'unknown'}".`)
  }

  const body = await readRawBody(event, false)
  if (!body || body.length === 0) {
    throw apiError(422, 'validation_failed', 'The request body was empty.')
  }
  if (body.length > MAX_POSTER_BYTES) {
    throw apiError(413, 'payload_too_large', `Poster art may be at most ${MAX_POSTER_BYTES} bytes; this was ${body.length}.`)
  }

  // Verify the content address server-side. Never trust the path.
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== claimed) {
    throw apiError(422, 'validation_failed', 'The bytes do not hash to the sha256 in the path.', {
      expected: claimed,
      actual
    })
  }

  if (!isStorageConfigured()) {
    throw apiError(500, 'internal', 'Object storage is not configured on this zäme instance.')
  }

  const key = posterObjectKey(actual)
  const store = createObjectStore()
  const alreadyPresent = await store.exists(key)
  if (!alreadyPresent) {
    await store.put(key, new Uint8Array(body), contentType)
  }

  return {
    // Absolute, for Enterprise to persist and re-send verbatim; the row keeps
    // the relative form (`normalisePosterUrl`) so the public gate matches.
    posterUrl: publicUrl(publicPosterUrl(key)),
    sha256: actual,
    bytes: body.length,
    contentType,
    alreadyPresent
  }
})
