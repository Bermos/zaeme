import { AwsClient } from 'aws4fetch'

/**
 * Cloudflare R2 (S3-compatible) client wrapper.
 *
 * Configured via environment variables:
 *   - R2_ACCOUNT_ID        required to derive the default endpoint
 *   - R2_ACCESS_KEY_ID     access key id
 *   - R2_SECRET_ACCESS_KEY secret access key
 *   - R2_BUCKET            bucket name
 *   - R2_ENDPOINT          optional — overrides the default R2 endpoint.
 *                          Any S3-compatible endpoint works (MinIO, Garage).
 *
 * When any required variable is missing, `isR2Configured()` returns false
 * and media upload/list endpoints short-circuit with 501 so deployments
 * without object storage stay functional.
 */

const UPLOAD_URL_TTL_SECONDS = 15 * 60
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60

interface R2Env {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  endpoint: string
}

function readEnv(): R2Env | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  const endpoint = process.env.R2_ENDPOINT
    ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined)

  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint || !accountId) {
    return null
  }
  return { accountId, accessKeyId, secretAccessKey, bucket, endpoint }
}

export function isR2Configured(): boolean {
  return readEnv() !== null
}

function getClient(env: R2Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.accessKeyId,
    secretAccessKey: env.secretAccessKey,
    service: 's3',
    // R2 ignores region but the signer requires one — `auto` is the
    // documented value for Cloudflare R2.
    region: 'auto'
  })
}

function requireEnv(): R2Env {
  const env = readEnv()
  if (!env) {
    throw createError({
      statusCode: 501,
      message: 'Object storage is not configured on this instance'
    })
  }
  return env
}

function objectUrl(env: R2Env, key: string): string {
  // Ensure we don't double-encode slashes in the key path.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return `${env.endpoint.replace(/\/$/, '')}/${env.bucket}/${encodedKey}`
}

/**
 * Generate a presigned PUT URL the browser can upload to directly.
 * The URL is valid for 15 minutes and locks in the content type and
 * content length to prevent spoofing.
 */
export async function presignUpload(
  key: string,
  contentType: string,
  sizeBytes: number
): Promise<{ url: string, method: 'PUT', headers: Record<string, string>, expiresInSeconds: number }> {
  const env = requireEnv()
  const client = getClient(env)
  const url = new URL(objectUrl(env, key))
  url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS))

  const signed = await client.sign(
    new Request(url.toString(), {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        'content-length': String(sizeBytes)
      }
    }),
    { aws: { signQuery: true, allHeaders: true } }
  )

  // Headers the caller must send verbatim alongside the PUT — the
  // signature binds them.
  return {
    url: signed.url,
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'content-length': String(sizeBytes)
    },
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS
  }
}

/**
 * Generate a presigned GET URL for download/inline display. Used by the
 * gallery so R2 bytes never flow through the Nuxt server.
 */
export async function presignDownload(key: string): Promise<string> {
  const env = requireEnv()
  const client = getClient(env)
  const url = new URL(objectUrl(env, key))
  url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_URL_TTL_SECONDS))

  const signed = await client.sign(url.toString(), {
    method: 'GET',
    aws: { signQuery: true }
  })
  return signed.url
}

/** Delete an object from R2. Best-effort — 404s are ignored. */
export async function deleteObject(key: string): Promise<void> {
  const env = requireEnv()
  const client = getClient(env)
  const res = await client.fetch(objectUrl(env, key), { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    throw createError({
      statusCode: 502,
      message: `Failed to delete object from storage (${res.status})`
    })
  }
}

/**
 * Build a deterministic R2 key for an event's media item.
 * Layout: `{eventId}/{mediaType}/{mediaId}.{ext}`
 * (matches the layout documented in ARCHITECTURE.md).
 */
export function buildMediaKey(
  eventId: string,
  mediaType: 'photo' | 'video' | 'document' | 'ticket',
  mediaId: string,
  fileName: string
): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const suffix = ext ? `.${ext}` : ''
  return `${eventId}/${mediaType}/${mediaId}${suffix}`
}
