/**
 * Object storage seam (ADR-0005).
 *
 * File access goes through this S3-compatible interface, never through Vercel/R2
 * specifics scattered in handlers. Cloudflare R2 is the implementation today;
 * MinIO/Garage or another cloud is a config/adapter change later, not a rewrite.
 *
 * The concrete `S3CompatibleStore` below is the aws4fetch presign/delete code
 * lifted from zaeme `server/utils/r2.ts` (which both departments shared informally
 * before this extraction), generalised off the R2-only env names.
 */

import { AwsClient } from 'aws4fetch'

const UPLOAD_URL_TTL_SECONDS = 15 * 60
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60

export interface PresignedUpload {
  url: string
  method: 'PUT'
  /** Headers the caller must send verbatim — the signature binds them. */
  headers: Record<string, string>
  expiresInSeconds: number
}

/** The capability every storage backend must provide. */
export interface ObjectStore {
  presignUpload(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>
  presignDownload(key: string): Promise<string>
  delete(key: string): Promise<void>
}

export interface StorageConfig {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  endpoint: string
  region: string
}

/**
 * Read storage config from the environment. Prefers the generic `S3_*` names;
 * accepts the legacy `R2_*` names so existing deployments keep working. For
 * Cloudflare R2 the endpoint is derived from the account id when not given.
 */
export function readStorageConfig(): StorageConfig | null {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET
  const accountId = process.env.S3_ACCOUNT_ID ?? process.env.R2_ACCOUNT_ID
  const endpoint = process.env.S3_ENDPOINT
    ?? process.env.R2_ENDPOINT
    ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined)
  const region = process.env.S3_REGION ?? 'auto'

  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    return null
  }
  return { accessKeyId, secretAccessKey, bucket, endpoint, region }
}

export function isStorageConfigured(): boolean {
  return readStorageConfig() !== null
}

/**
 * An S3-compatible object store backed by aws4fetch (AWS Signature v4). Works
 * against Cloudflare R2 today and any S3-compatible endpoint (MinIO, Garage)
 * by config. Ported from zaeme `server/utils/r2.ts`; the only change is that
 * the endpoint/bucket/region come from `StorageConfig` instead of R2_* env reads.
 */
export class S3CompatibleStore implements ObjectStore {
  private readonly client: AwsClient

  constructor(private readonly config: StorageConfig) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      // R2 ignores region but the signer requires one — `auto` is the
      // documented value for Cloudflare R2.
      region: config.region || 'auto'
    })
  }

  /** Fully-qualified object URL, with each key segment encoded independently. */
  private objectUrl(key: string): string {
    const encodedKey = key.split('/').map(encodeURIComponent).join('/')
    return `${this.config.endpoint.replace(/\/$/, '')}/${this.config.bucket}/${encodedKey}`
  }

  /**
   * Generate a presigned PUT URL the browser can upload to directly. Valid for
   * 15 minutes; locks in the content type and length to prevent spoofing.
   */
  async presignUpload(key: string, contentType: string, sizeBytes: number): Promise<PresignedUpload> {
    const url = new URL(this.objectUrl(key))
    url.searchParams.set('X-Amz-Expires', String(UPLOAD_URL_TTL_SECONDS))

    const signed = await this.client.sign(
      new Request(url.toString(), {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-length': String(sizeBytes)
        }
      }),
      { aws: { signQuery: true, allHeaders: true } }
    )

    return {
      url: signed.url,
      method: 'PUT',
      // Headers the caller must send verbatim alongside the PUT — the signature
      // binds them.
      headers: {
        'content-type': contentType,
        'content-length': String(sizeBytes)
      },
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS
    }
  }

  /** Generate a presigned GET URL for download/inline display (1h TTL). */
  async presignDownload(key: string): Promise<string> {
    const url = new URL(this.objectUrl(key))
    url.searchParams.set('X-Amz-Expires', String(DOWNLOAD_URL_TTL_SECONDS))
    const signed = await this.client.sign(url.toString(), {
      method: 'GET',
      aws: { signQuery: true }
    })
    return signed.url
  }

  /** Delete an object. Best-effort — 404s are ignored. */
  async delete(key: string): Promise<void> {
    const res = await this.client.fetch(this.objectUrl(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete object from storage (${res.status})`)
    }
  }
}

/**
 * Resolve the active object store. When storage is unconfigured the methods
 * fail loudly, so callers can gate on `isStorageConfigured()` and short-circuit
 * media features (mirroring zaeme's 501 behaviour) rather than crashing.
 */
export function createObjectStore(): ObjectStore {
  const config = readStorageConfig()
  if (config) {
    return new S3CompatibleStore(config)
  }
  return unconfiguredStore()
}

function unconfiguredStore(): ObjectStore {
  const fail = (): never => {
    throw new Error('Object storage is not configured on this instance')
  }
  return {
    presignUpload: async () => fail(),
    presignDownload: async () => fail(),
    delete: async () => fail()
  }
}
