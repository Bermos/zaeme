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
 * their own upload (`requireUploadedByRsvpId`), and so may a signed-in
 * participant (`requireUploadedByUserId`).
 */
export async function confirmMediaUpload(
  eventId: string,
  mediaId: string,
  input: { caption?: string | null, takenAt?: string | Date | null } = {},
  opts: { requireUploadedByRsvpId?: string, requireUploadedByUserId?: string } = {}
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
  // The account half of the same rule (#29): a participant confirms the row
  // THEY registered, not whatever pending id they can name.
  if (opts.requireUploadedByUserId && row.uploadedByUserId !== opts.requireUploadedByUserId) {
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
  /** The expense this item is the receipt for, or `null` (#29). */
  expenseId: string | null
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
    expenseId: r.expenseId,
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

/* -------------------------- the receipt pin (#29) -------------------------- */

/**
 * WHAT MAY BE A RECEIPT, and the rule is about who can already see the bytes
 * rather than about what a receipt looks like.
 *
 * A pinned receipt travels in the budget, and the budget is readable by anybody
 * holding the invite link (`GET /api/invites/{token}/budget`, unchanged since
 * #48). `photo` and `document` are exactly the two classes
 * `listMediaForViewer` already hands that same population unconditionally, so
 * pinning one widens NOTHING: every reader of the pin could already fetch the
 * object from the gallery.
 *
 * `ticket` is excluded for that reason and no other. A ticket is per-person —
 * visible to the attendee it is assigned to and to planners — and pinning one
 * to an expense would publish it to the whole trip through a side door, which
 * is a change to who may read what and therefore not this issue's to make.
 * `video` is excluded because a receipt is a still or a paper; it would be
 * harmless (the gallery shows videos to everyone) and it is simply not the
 * thing.
 */
export const RECEIPT_TYPES: readonly MediaType[] = ['photo', 'document']

/**
 * Pin a photo or a shared paper to an expense as its receipt.
 *
 * The CALLER decides whether this account may write this trip's money — the
 * gate is the expense gate (`server/domain/expenses.ts`), because pinning a
 * receipt is an expense write and #48 decided who may make one. What this
 * function owns is the pin itself: that both rows are on the event named, that
 * the object is one this event's readers may already see, and that an expense
 * ends up with at most one.
 *
 * REPLACING IS ONE STATEMENT, so it is one transaction — and the transaction is
 * NOT what makes it safe. A TRANSACTION IS NOT A LOCK. Under Postgres's default
 * READ COMMITTED, two concurrent pins to the same expense each run
 *
 *     update events_media set expense_id = null where expense_id = <this one>
 *
 * against a snapshot in which the rival's row is still `NULL` as committed. The
 * statement matches no rows, so it takes no lock at all, and both go on to set
 * their own — leaving ONE EXPENSE WITH TWO RECEIPTS, which is exactly what the
 * column's comment in `server/database/schema/events.ts` says cannot happen.
 * Reproduced on Postgres 16 with two psql sessions before this line was written.
 *
 * THE FIX IS A ROW THAT EXISTS: the expense is selected `FOR UPDATE` inside the
 * transaction, so the two claimants serialise on `events_expense`, which is
 * there in both snapshots, and the second does its clear against what the first
 * committed. A partial unique index would also hold the invariant and is
 * declined for the reason given on the column — it would turn a replace into a
 * two-statement dance around a constraint. A row lock has no such cost.
 *
 * IT STILL TOUCHES NO COLUMN ON `events_expense`. Not `fx_rate_source`, not
 * `stated_amount_cents`, not `updated_at` — `SELECT … FOR UPDATE` locks a row,
 * it does not write one. Those columns record that a PERSON stated a figure and
 * checked it (#59, #71); a photograph is evidence a reader can look at, not a
 * claim the instance may make on the uploader's behalf.
 */
export async function pinReceipt(eventId: string, expenseId: string, mediaId: string): Promise<MediaItemView> {
  const db = useDb()

  // The media checks stay OUTSIDE the transaction: they are what turns a bad
  // request into a 404/409/422, they need no lock, and holding one across them
  // would widen the window for nothing.
  const [item] = await db
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, eventId)))
    .limit(1)
  // Same 404 for "no such id" and "somebody else's event": a media id from
  // another trip is not a thing this caller is entitled to learn about.
  if (!item) throw createError({ statusCode: 404, message: 'Photo not found' })
  if (item.status !== 'ready') {
    throw createError({ statusCode: 409, message: 'That upload has not finished yet' })
  }
  if (!RECEIPT_TYPES.includes(item.type as MediaType)) {
    throw createError({
      statusCode: 422,
      message: 'A receipt is a photo or a shared document — a ticket belongs to one person and stays theirs'
    })
  }

  return db.transaction(async (tx) => {
    // THE LOCK, and the reason the expense lookup is in here rather than beside
    // the media one above. See the header: this is the row both claimants can
    // see, so it is the row they can queue on.
    const [target] = await tx
      .select({ id: tables.expense.id })
      .from(tables.expense)
      .where(and(eq(tables.expense.id, expenseId), eq(tables.expense.eventId, eventId)))
      .limit(1)
      .for('update')
    if (!target) throw createError({ statusCode: 404, message: 'Expense not found' })

    await tx
      .update(tables.media)
      .set({ expenseId: null })
      .where(and(eq(tables.media.eventId, eventId), eq(tables.media.expenseId, expenseId)))
    const [pinned] = await tx
      .update(tables.media)
      .set({ expenseId })
      .where(and(eq(tables.media.id, item.id), eq(tables.media.eventId, eventId)))
      .returning()
    // Zero rows is reachable: a planner may delete the photo between the read
    // above and this write. A refusal, not a 500 — every other way this
    // function declines is a status somebody can act on.
    if (!pinned) throw createError({ statusCode: 404, message: 'Photo not found' })
    return toView(pinned)
  })
}

/**
 * Un-pin whatever this expense's receipt is. The photo stays in the gallery —
 * this is the pin coming off, never a delete, and there is exactly one way to
 * remove the bytes (`DELETE /api/host/events/{slug}/media/{id}`, planner only).
 *
 * Idempotent, and answers what it did rather than 404ing on an expense that has
 * no receipt: "there is no receipt" is the state the caller asked for.
 */
export async function unpinReceipt(eventId: string, expenseId: string): Promise<{ removed: boolean }> {
  const cleared = await useDb()
    .update(tables.media)
    .set({ expenseId: null })
    .where(and(eq(tables.media.eventId, eventId), eq(tables.media.expenseId, expenseId)))
    .returning({ id: tables.media.id })
  return { removed: cleared.length > 0 }
}

/**
 * The receipts of a whole budget, by expense id — ONE query for the lot.
 *
 * Read by `loadBudget` (`server/domain/expenses.ts`), which is the read half
 * the issue asks for. It is a batch on purpose: a budget renders every expense,
 * and a per-expense lookup here would be the N+1 that `server/domain/admin.ts`
 * has a note about at the top of it.
 *
 * `status = 'ready'` because a pending row is an upload that may never land,
 * and a thumbnail pointing at an object that does not exist is worse than no
 * thumbnail. Nothing can pin one anyway (`pinReceipt` refuses), so this is the
 * belt to that braces.
 */
export async function listReceiptsByExpense(eventId: string, expenseIds: string[]): Promise<Map<string, MediaItemView>> {
  const out = new Map<string, MediaItemView>()
  if (expenseIds.length === 0) return out
  const rows = await useDb()
    .select()
    .from(tables.media)
    .where(and(
      eq(tables.media.eventId, eventId),
      eq(tables.media.status, 'ready'),
      inArray(tables.media.expenseId, expenseIds)
    ))
  for (const r of rows) {
    // `expenseId` is non-null by the `inArray` above; the guard is for the type.
    if (r.expenseId) out.set(r.expenseId, toView(r))
  }
  return out
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
