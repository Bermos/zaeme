import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'

/**
 * Event media: the per-type MIME/size policy, the storage-key layout, and the
 * two-step upload's DB half (register pending → confirm ready). The storage
 * *transport* (presigning, see `server/utils/storage.ts`) stays in the API
 * handlers — the domain keeps its dependency-light contract.
 *
 * Photos/videos are the social gallery — anyone on the event may contribute
 * and everyone sees them. Documents (reservations, itineraries) are shared
 * papers — visible to everyone on the event. Tickets are per-person: a ticket
 * assigned to an RSVP is visible only to that attendee (and planners).
 */

export type MediaType = 'photo' | 'video' | 'document' | 'ticket'

/** Media type → allowed MIME prefixes. */
export const MEDIA_TYPE_MIME: Record<MediaType, RegExp> = {
  photo: /^image\//,
  video: /^video\//,
  document: /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-|text\/)/,
  ticket: /^(application\/pdf|image\/png|image\/jpeg)$/
}

/** Per-type size limit in bytes. Enforced on both presign and confirm. */
export const MEDIA_TYPE_MAX_BYTES: Record<MediaType, number> = {
  photo: 25 * 1024 * 1024, // 25 MB
  video: 500 * 1024 * 1024, // 500 MB
  document: 25 * 1024 * 1024,
  ticket: 10 * 1024 * 1024
}

/**
 * Deterministic object key for an event's media item:
 * `{eventId}/{mediaType}/{mediaId}.{ext}`.
 */
export function buildMediaKey(eventId: string, mediaType: MediaType, mediaId: string, fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : ''
  const suffix = ext ? `.${ext}` : ''
  return `${eventId}/${mediaType}/${mediaId}${suffix}`
}

export interface RegisterMediaInput {
  type: MediaType
  fileName: string
  mimeType: string
  sizeBytes: number
}

export interface MediaUploader {
  userId?: string | null
  rsvpId?: string | null
}

/**
 * Two-step upload, DB half of step 1: validate the policy and insert the
 * `pending` row. The caller presigns `storageKey` with its own object store.
 */
export async function registerMediaUpload(eventId: string, input: RegisterMediaInput, by: MediaUploader) {
  if (!MEDIA_TYPE_MIME[input.type].test(input.mimeType)) {
    throw createError({ statusCode: 422, message: `MIME type ${input.mimeType} not allowed for ${input.type}` })
  }
  if (input.sizeBytes > MEDIA_TYPE_MAX_BYTES[input.type]) {
    throw createError({ statusCode: 413, message: `File exceeds the limit for ${input.type}` })
  }

  const mediaId = createId()
  const storageKey = buildMediaKey(eventId, input.type, mediaId, input.fileName)
  await useDb().insert(tables.media).values({
    id: mediaId,
    eventId,
    type: input.type,
    status: 'pending',
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    fileName: input.fileName,
    uploadedByUserId: by.userId ?? null,
    uploadedByRsvpId: by.rsvpId ?? null
  })
  return { mediaId, storageKey }
}

/**
 * Two-step upload, step 2: mark the object `ready`. A guest may only confirm
 * their own upload (`requireUploadedByRsvpId`).
 */
export async function confirmMediaUpload(
  eventId: string,
  mediaId: string,
  input: { caption?: string | null, takenAt?: string | Date | null } = {},
  opts: { requireUploadedByRsvpId?: string } = {}
) {
  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'Upload not found' })
  if (opts.requireUploadedByRsvpId && row.uploadedByRsvpId !== opts.requireUploadedByRsvpId) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  const [updated] = await db
    .update(tables.media)
    .set({
      status: 'ready',
      caption: input.caption ?? row.caption,
      takenAt: input.takenAt ? new Date(input.takenAt) : row.takenAt
    })
    .where(eq(tables.media.id, row.id))
    .returning()
  return updated!
}

export interface MediaItemView {
  id: string
  type: MediaType
  storageKey: string
  mimeType: string
  fileName: string
  caption: string | null
  takenAt: Date | null
  assignedRsvpId: string | null
  createdAt: Date
}

function toView(r: typeof tables.media.$inferSelect): MediaItemView {
  return {
    id: r.id,
    type: r.type as MediaType,
    storageKey: r.storageKey,
    mimeType: r.mimeType,
    fileName: r.fileName,
    caption: r.caption,
    takenAt: r.takenAt,
    assignedRsvpId: r.assignedRsvpId,
    createdAt: r.createdAt
  }
}

/**
 * What one viewer may see, split by handling class: the gallery (photos +
 * videos, everyone's), the shared documents, and the viewer's own tickets
 * (matched through their RSVP email). Storage keys only — the caller signs
 * download URLs with its own store.
 */
export async function listMediaForViewer(eventId: string, viewerEmail: string | null): Promise<{
  gallery: MediaItemView[]
  documents: MediaItemView[]
  tickets: MediaItemView[]
}> {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.eventId, eventId), eq(tables.media.status, 'ready')))
    .orderBy(desc(tables.media.takenAt), desc(tables.media.createdAt))

  let myRsvpIds = new Set<string>()
  if (viewerEmail) {
    const myRsvps = await db
      .select({ id: tables.rsvp.id })
      .from(tables.rsvp)
      .where(and(eq(tables.rsvp.eventId, eventId), eq(tables.rsvp.guestEmail, viewerEmail.toLowerCase())))
    myRsvpIds = new Set(myRsvps.map(r => r.id))
  }

  return {
    gallery: rows.filter(r => r.type === 'photo' || r.type === 'video').map(toView),
    documents: rows.filter(r => r.type === 'document').map(toView),
    tickets: rows
      .filter(r => r.type === 'ticket' && r.assignedRsvpId && myRsvpIds.has(r.assignedRsvpId))
      .map(toView)
  }
}

/** Everything, for a planner — including unassigned tickets awaiting assignment. */
export async function listMediaForPlanner(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  const rows = await useDb()
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.eventId, ev.id), eq(tables.media.status, 'ready')))
    .orderBy(asc(tables.media.type), desc(tables.media.createdAt))
  return rows.map(toView)
}

/** Assign (or unassign) a ticket to an attendee's RSVP (owner/co-planner only). */
export async function assignTicket(userId: string, slug: string, mediaId: string, rsvpId: string | null) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  if (rsvpId) {
    const [target] = await useDb()
      .select({ id: tables.rsvp.id })
      .from(tables.rsvp)
      .where(and(eq(tables.rsvp.id, rsvpId), eq(tables.rsvp.eventId, ev.id)))
      .limit(1)
    if (!target) throw createError({ statusCode: 404, message: 'RSVP not found' })
  }

  const [updated] = await useDb()
    .update(tables.media)
    .set({ assignedRsvpId: rsvpId })
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, ev.id), eq(tables.media.type, 'ticket')))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Ticket not found' })
  return toView(updated)
}

/**
 * Delete a media row (owner/co-planner only) and return its storage key so the
 * caller can delete the object from its store.
 */
export async function deleteMedia(userId: string, slug: string, mediaId: string): Promise<{ storageKey: string }> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  const [deleted] = await useDb()
    .delete(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, ev.id)))
    .returning({ storageKey: tables.media.storageKey })
  if (!deleted) throw createError({ statusCode: 404, message: 'Media not found' })
  return deleted
}

/** Resolve an invite-holder's RSVP id by email — the guest upload attribution. */
export async function findRsvpIdByEmail(eventId: string, email: string): Promise<string | null> {
  const [row] = await useDb()
    .select({ id: tables.rsvp.id })
    .from(tables.rsvp)
    .where(and(eq(tables.rsvp.eventId, eventId), eq(tables.rsvp.guestEmail, email.toLowerCase())))
    .limit(1)
  return row?.id ?? null
}

/** Batch metadata lookup used by delete flows that clean the object store. */
export async function listMediaByIds(eventId: string, ids: string[]) {
  if (ids.length === 0) return []
  return useDb()
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.eventId, eventId), inArray(tables.media.id, ids)))
}
