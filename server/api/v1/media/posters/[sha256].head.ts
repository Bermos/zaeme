import { isSha256Hex, posterObjectKey } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { apiError } from '#server/utils/api-v1'
import { createObjectStore, isStorageConfigured } from '#server/utils/storage'

/**
 * `headPoster` — "do you already hold these bytes?"
 *
 * This exists so a republish of an unchanged concert costs nothing, so it has to
 * genuinely short-circuit: ONE `HEAD` against the object store keyed by the
 * content digest, no bytes transferred, no database touched, no body returned.
 * A 204 means the caller can skip `uploadPoster` entirely.
 */
export default defineServiceHandler(async (event) => {
  const sha256 = (getRouterParam(event, 'sha256') || '').toLowerCase()
  if (!isSha256Hex(sha256)) {
    // Not a content address, so nothing can be stored under it.
    setResponseStatus(event, 404)
    return null
  }
  if (!isStorageConfigured()) {
    throw apiError(500, 'internal', 'Object storage is not configured on this zäme instance.')
  }

  const present = await createObjectStore().exists(posterObjectKey(sha256))
  setResponseStatus(event, present ? 204 : 404)
  return null
})
