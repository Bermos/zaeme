/**
 * Browser-side helper driving the two-step media upload flow:
 *   1. POST /api/media/presign — server allocates a pending row + presigned PUT URL
 *   2. PUT {url} directly to R2 with the raw bytes
 *   3. POST /api/media/confirm — flip the row to `ready`, attach caption/takenAt
 *
 * Returns the media id on success. Errors bubble up so the caller can
 * toast them.
 */
export interface UploadMediaArgs {
  file: File
  type: 'photo' | 'video' | 'document' | 'ticket'
  /** Planner context (mutually exclusive with `rsvpToken`). */
  eventSlug?: string
  /** Guest context (mutually exclusive with `eventSlug`). */
  rsvpToken?: string
  caption?: string | null
  /**
   * Explicit capture timestamp (ISO). Optional — when omitted, the server
   * falls back to `createdAt` for timeline ordering.
   */
  takenAt?: string | null
}

interface PresignResponse {
  mediaId: string
  storageKey: string
  upload: {
    url: string
    method: 'PUT'
    headers: Record<string, string>
    expiresInSeconds: number
  }
}

interface ConfirmResponse {
  media: { id: string }
}

export function useMediaUpload() {
  async function upload(args: UploadMediaArgs): Promise<{ mediaId: string }> {
    const presign = await $fetch<PresignResponse>('/api/media/presign', {
      method: 'POST',
      body: {
        eventSlug: args.eventSlug,
        rsvpToken: args.rsvpToken,
        type: args.type,
        fileName: args.file.name,
        mimeType: args.file.type || 'application/octet-stream',
        sizeBytes: args.file.size
      }
    })

    const putRes = await fetch(presign.upload.url, {
      method: 'PUT',
      headers: presign.upload.headers,
      body: args.file
    })
    if (!putRes.ok) {
      throw new Error(`Upload failed (${putRes.status})`)
    }

    const confirm = await $fetch<ConfirmResponse>('/api/media/confirm', {
      method: 'POST',
      body: {
        eventSlug: args.eventSlug,
        rsvpToken: args.rsvpToken,
        mediaId: presign.mediaId,
        caption: args.caption ?? null,
        takenAt: args.takenAt ?? null
      }
    })

    return { mediaId: confirm.media.id }
  }

  /** Map a user-selected File to the best-fit media type (photo/video/document). */
  function detectType(file: File): 'photo' | 'video' | 'document' {
    if (file.type.startsWith('image/')) return 'photo'
    if (file.type.startsWith('video/')) return 'video'
    return 'document'
  }

  return { upload, detectType }
}
