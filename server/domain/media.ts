import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import { isPinnableToTimeline } from '../../shared/utils/pinned-media'

/**
 * Event media: the per-type MIME/size policy, the storage-key layout, and the
 * two-step upload's DB half (register pending → confirm ready). The storage
 * *transport* (presigning, see `server/utils/storage.ts`) stays in the API
 * handlers — the domain keeps its dependency-light contract.
 *
 * Photos/videos are the social gallery — anyone on the event may contribute
 * and everyone sees them. Documents (reservations, itineraries) are shared
 * papers — visible to everyone on the event. Tickets are ASSIGNED per person —
 * since #36 to a LIST of people rather than one, because a pair fare, a family
 * entry and one QR code for six are all one ticket several people are behind —
 * but since #37 assignment is a LABEL and not a lock: everyone on the event
 * sees every ticket, and the assignment says whose it is so a person can find
 * theirs quickly. `mine` on `GuestTicketView` is that label; there is no
 * per-event toggle and nothing stored about visibility.
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

/**
 * What a ticket SAYS (#35) — every field nullable, because a ticket with
 * nothing filled in is still a ticket.
 *
 * The domain-side twin of `TicketDetailFields` in
 * `shared/utils/ticket-detail.ts`, which is what turns these into the line a
 * person reads. The two are kept apart on purpose: this one carries `Date`s
 * straight off the column, the shared one accepts whatever survived JSON.
 */
export interface TicketDetailView {
  bookingRef: string | null
  carrier: string | null
  seat: string | null
  coach: string | null
  travellerName: string | null
  validFrom: Date | null
  validUntil: Date | null
  note: string | null
}

export interface MediaItemView {
  id: string
  type: MediaType
  storageKey: string
  mimeType: string
  fileName: string
  caption: string | null
  takenAt: Date | null
  /**
   * For a ticket, EVERY attendee it is for (#36) — a pair fare has two, a
   * family entry has four, an unassigned ticket has none. Always empty for a
   * photo, a video and a document: nothing else is assigned to anybody.
   *
   * A LIST AND NEVER A SCALAR. `assignedRsvpId` was one nullable id, which is
   * why one ticket could not cover two people; a reader that wants "is this
   * mine" asks whether it CONTAINS one of the viewer's RSVP ids, which is the
   * rule `listMediaForViewer` applies below.
   */
  assignedRsvpIds: string[]
  /**
   * The itinerary step this item is pinned to, or `null` (#38).
   *
   * THE COLUMN HAS EXISTED SINCE THE TRANSPLANT AND NO HUMAN SURFACE HAS EVER
   * CARRIED IT. `server/domain/events-data.ts` selects it for `/api/v1`, so
   * Enterprise has been told which step a ticket belongs to for as long as the
   * field has existed, while the two reads a PERSON looks at — this view, which
   * feeds the host card and the invite link — dropped it before it reached a
   * screen. That is why the itinerary never said it back.
   *
   * `null` is "pinned to nothing", which is every photo, every receipt and most
   * papers; it is never "this caller did not look", because it comes straight
   * off the row like `expenseId` below it.
   */
  timelineItemId: string | null
  /** The expense this item is the receipt for, or `null` (#29). */
  expenseId: string | null
  /**
   * For a ticket, what is printed on it (#35), or `null` when nobody has
   * written any of it down — which is every ticket uploaded before this
   * existed, and every one uploaded since by somebody who had a PDF and
   * nothing else. Always `null` for a photo, a video or a document: no other
   * type has a detail row, and nothing will make one.
   */
  ticket: TicketDetailView | null
  createdAt: Date
}

function toDetailView(d: typeof tables.ticketDetail.$inferSelect): TicketDetailView {
  return {
    bookingRef: d.bookingRef,
    carrier: d.carrier,
    seat: d.seat,
    coach: d.coach,
    travellerName: d.travellerName,
    validFrom: d.validFrom,
    validUntil: d.validUntil,
    note: d.note
  }
}

/**
 * BOTH TRAILING ARGUMENTS ARE REQUIRED, AND NEITHER HAS A DEFAULT.
 *
 * `assignedRsvpIds` used to be a column on the row, so it arrived here whether
 * or not the caller had thought about it. It is a second table now, and an
 * optional parameter defaulting to `[]` would make "this item has no assignees"
 * and "this caller forgot to load them" the same value — on a surface where the
 * wrong one of those is a ticket that silently stops being anybody's. #35 lost
 * a whole release to exactly that shape with an optional `timezone` prop, so
 * both are positional and required and `nuxt typecheck` is what notices.
 *
 * `null` for `detail` is how a caller SAYS "there is no detail row", which is a
 * different statement from forgetting to look.
 */
function toView(
  r: typeof tables.media.$inferSelect,
  detail: typeof tables.ticketDetail.$inferSelect | null | undefined,
  assignedRsvpIds: string[]
): MediaItemView {
  return {
    id: r.id,
    type: r.type as MediaType,
    storageKey: r.storageKey,
    mimeType: r.mimeType,
    fileName: r.fileName,
    caption: r.caption,
    takenAt: r.takenAt,
    assignedRsvpIds,
    timelineItemId: r.timelineItemId,
    expenseId: r.expenseId,
    ticket: detail ? toDetailView(detail) : null,
    createdAt: r.createdAt
  }
}

/**
 * The detail rows for a set of media ids, keyed by media id — ONE query for the
 * lot, for the reason `listReceiptsByExpense` below is a batch: a gallery
 * renders every item, and a per-item lookup here is the N+1
 * `server/domain/admin.ts` has a note about at the top of it.
 */
async function loadTicketDetails(mediaIds: string[]): Promise<Map<string, typeof tables.ticketDetail.$inferSelect>> {
  const out = new Map<string, typeof tables.ticketDetail.$inferSelect>()
  if (mediaIds.length === 0) return out
  const rows = await useDb()
    .select()
    .from(tables.ticketDetail)
    .where(inArray(tables.ticketDetail.mediaId, mediaIds))
  for (const d of rows) out.set(d.mediaId, d)
  return out
}

/**
 * WHO EACH OF THESE TICKETS IS FOR (#36), keyed by media id — ONE query for the
 * lot, for the same reason `loadTicketDetails` above is a batch.
 *
 * EXPORTED, and that is the point of it rather than an accident. There are
 * three reads that project a media row for somebody — `listMediaForPlanner`
 * below, `listMedia` in `server/domain/events-data.ts` (which answers `/api/v1`
 * with a different projection and a different order) and `guestListMedia` in
 * `server/domain/guest.ts` through `listMediaForViewer` — and they share no
 * code at all. A field added to one and not to the others is invisible to
 * `pnpm test`: the contract test polices paths and methods, and
 * `server/utils/v1-shapes.ts` reads its row through an unchecked cast
 * (Bermos/zaeme#78), so a shape that reads what its feeder never selected
 * answers `null` on the wire with `nuxt typecheck` green. #29's `expenseId` and
 * #35's `ticket` each shipped that way. One shared loader is one fewer place
 * for the fourth one to happen.
 *
 * A key is absent for a ticket nobody has been given, so every caller resolves
 * `?? []` — which is the honest empty rather than a gap.
 */
export async function loadTicketAssignments(mediaIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (mediaIds.length === 0) return out
  const rows = await useDb()
    .select({ mediaId: tables.ticketAssignment.mediaId, rsvpId: tables.ticketAssignment.rsvpId })
    .from(tables.ticketAssignment)
    .where(inArray(tables.ticketAssignment.mediaId, mediaIds))
    // Oldest assignee first, `rsvpId` breaking the tie: two rows written by one
    // statement share `created_at` to the microsecond (Postgres `now()` is
    // transaction time) and cuid2 ids do not sort by age, so stopping at
    // `created_at` would give a stable-but-arbitrary order that two readers can
    // disagree about. #37 renders this list with a name against each entry.
    .orderBy(asc(tables.ticketAssignment.createdAt), asc(tables.ticketAssignment.rsvpId))
  for (const r of rows) {
    const list = out.get(r.mediaId)
    if (list) list.push(r.rsvpId)
    else out.set(r.mediaId, [r.rsvpId])
  }
  return out
}

/**
 * WHO A TICKET IS FOR, IN WORDS, on the surface that has no other way to know
 * (#37). The invite page's `attendees` list is names with no RSVP ids on it, so
 * an id alone would render as a cuid2 — this resolves it here, once, beside the
 * list it labels.
 *
 * `rsvpId` travels beside the name rather than the name alone: two friends
 * genuinely called Ben are not the same person, and a parallel array of names
 * would be a second answer to the question `assignedRsvpIds` already answers.
 * It is DERIVED from that one list (below) and never assembled separately.
 */
export interface TicketAssigneeView {
  rsvpId: string
  /** What the group calls them — the same name `attendees` shows, never an email. */
  name: string
}

/**
 * A ticket as the invite link answers it (#37), which is a media item plus the
 * two things only this surface knows: whether it is the VIEWER's, and who else
 * it is for by name.
 */
export interface GuestTicketView extends MediaItemView {
  /**
   * Whether the viewer is one of the assignees — an intersection, not an
   * equality (#36): a pair fare is `true` for both halves of the couple.
   * `false` for every ticket when the read carried no email, and `false` for a
   * ticket assigned to nobody.
   *
   * SERVER-DECIDED, because the browser does not have the viewer's RSVP ids and
   * never will: the guest page is given names, not ids. It is a MARKER and not
   * a gate — see this function's header.
   */
  mine: boolean
  /** Everybody this ticket is for, named. Empty for a ticket nobody has yet. */
  assignedTo: TicketAssigneeView[]
}

/**
 * What one viewer may see, split by handling class: the gallery (photos +
 * videos, everyone's), the shared documents, and EVERY ticket on the event,
 * each marked as the viewer's or not. Storage keys only — the caller signs
 * download URLs with its own store.
 *
 * ── THE TICKETS ARE NO LONGER FILTERED, AND THAT IS #37 ──
 *
 * This function used to return the viewer's own tickets and nothing else. That
 * is right at a busy barrier with one phone per person and wrong at a busy
 * barrier with one phone between four, which is the case it was actually
 * written for: the friend whose battery survived could open their own ticket
 * and nobody else's, and the group was stuck at the gate holding a link that
 * had every file on it.
 *
 * The owner's decision (#37, D2 revised 2026-09-14) is that this was never a
 * permission boundary: "it's for friends, we do not need to segregate during an
 * event between members. We should have two buttons, show and show all." So
 * anyone holding the invite capability URL reaches every ticket on the event,
 * and `mine` is a convenience for finding yours quickly. There is no per-event
 * toggle and no column — the widening is unconditional and deliberate.
 *
 * IT IS EXACTLY TICKETS. `documents` and the gallery keep the rule they had;
 * loosening either of them for symmetry would be a decision nobody has made.
 *
 * AND THE EMAIL NEVER AUTHENTICATED ANYBODY. `?email=` is asserted by the
 * caller and always was — anybody with the link can pass anybody's address —
 * which is why it could never have been the thing holding tickets apart. What
 * changes here is that the consequence is now explicit and owner-authorised
 * rather than implied by a filter that looked like a gate.
 */
export async function listMediaForViewer(eventId: string, viewerEmail: string | null): Promise<{
  gallery: MediaItemView[]
  documents: MediaItemView[]
  tickets: GuestTicketView[]
}> {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.eventId, eventId), eq(tables.media.status, 'ready')))
    .orderBy(desc(tables.media.takenAt), desc(tables.media.createdAt))

  const ticketRows = rows.filter(r => r.type === 'ticket')
  const ticketIds = ticketRows.map(r => r.id)

  // THE ASSIGNMENTS ARE READ FIRST AND THE PEOPLE SECOND, on purpose. The RSVP
  // read is the LOOKUP side, and a lookup map built before the rows that point
  // into it can be missing an entry a concurrent RSVP created in between —
  // which would render somebody's name as a fallback for no reason anybody
  // could reproduce. Reading it second makes the map a superset. (`loadBudget`
  // had this exact bug the other way round and it cost somebody's balance.)
  const assignments = await loadTicketAssignments(ticketIds)
  const [details, people] = await Promise.all([
    // EVERY ticket's detail now, where this used to look up only the viewer's.
    // The seat travels with the ticket it belongs to: a screen that offers the
    // whole group's tickets and withholds what is written on them is the half
    // of #35 that matters at a barrier, withheld from the person actually
    // standing at it.
    loadTicketDetails(ticketIds),
    db
      .select({ id: tables.rsvp.id, name: tables.rsvp.guestName, email: tables.rsvp.guestEmail })
      .from(tables.rsvp)
      .where(eq(tables.rsvp.eventId, eventId))
  ])

  const nameByRsvpId = new Map(people.map(p => [p.id, p.name || 'Guest']))
  // THE MATCHING RULE (#36), and it is an intersection rather than an equality:
  // a ticket is this viewer's if they are ANY of its assignees. A pair fare
  // bought for two people is on both their screens, and neither of them has to
  // be "the" assignee for it to be theirs.
  const lower = viewerEmail?.toLowerCase() ?? null
  const myRsvpIds = new Set(
    lower ? people.filter(p => (p.email ?? '').toLowerCase() === lower).map(p => p.id) : []
  )

  return {
    gallery: rows.filter(r => r.type === 'photo' || r.type === 'video').map(r => toView(r, null, [])),
    documents: rows.filter(r => r.type === 'document').map(r => toView(r, null, [])),
    // BOTH NEW FIELDS ARE DERIVED FROM `assignedRsvpIds` AND NOT ASSEMBLED
    // BESIDE IT. A ticket that is "mine" while naming nobody, or named for
    // three people while listing two ids, would be one row answering the same
    // question twice — the shape the single `assignedRsvpId` beside the list
    // had, and the reason #36 removed it rather than keeping both.
    tickets: ticketRows
      .map(r => toView(r, details.get(r.id), assignments.get(r.id) ?? []))
      .map(v => ({
        ...v,
        mine: v.assignedRsvpIds.some(id => myRsvpIds.has(id)),
        assignedTo: v.assignedRsvpIds.map(id => ({ rsvpId: id, name: nameByRsvpId.get(id) ?? 'Guest' }))
      }))
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
  const ticketIds = rows.filter(r => r.type === 'ticket').map(r => r.id)
  const [details, assignments] = await Promise.all([
    loadTicketDetails(ticketIds),
    loadTicketAssignments(ticketIds)
  ])
  return rows.map(r => toView(r, details.get(r.id), assignments.get(r.id) ?? []))
}

/* --------------------------- who a ticket is for (#36) --------------------- */

/**
 * The planner's gate on assignment, the event, and the ticket it names — shared
 * by the add and the remove below so the two cannot drift apart about which
 * role may do it or what a bad id answers.
 *
 * `logistics` is deliberately not one of the roles: a ticket is somebody's
 * seat, and the role set that may say who it is for is the role set that may
 * say what is written on it (`setTicketDetail`, #74's lesson applied).
 */
async function assertMayAssign(userId: string, slug: string, mediaId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [item] = await useDb()
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, ev.id)))
    .limit(1)
  // The same 404 for "no such id" and "a media id from another trip": which of
  // the two it is, is not something this caller is entitled to learn.
  if (!item) throw createError({ statusCode: 404, message: 'Ticket not found' })
  if (item.type !== 'ticket') {
    throw createError({
      statusCode: 422,
      message: 'Only a ticket is assigned to somebody — a photo and a shared document belong to the whole trip'
    })
  }
  return { ev, item }
}

/**
 * The answer both verbs give: the ticket as it now stands, with everybody it is
 * for and whatever is written on it.
 *
 * The detail comes back with it (#35). Answering `ticket: null` here would be
 * this function claiming a ticket has nothing written on it because its
 * assignees just changed, which is a different sentence from the one it means.
 */
async function ticketAfterAssignment(item: typeof tables.media.$inferSelect): Promise<MediaItemView> {
  const [details, assignments] = await Promise.all([
    loadTicketDetails([item.id]),
    loadTicketAssignments([item.id])
  ])
  return toView(item, details.get(item.id), assignments.get(item.id) ?? [])
}

/**
 * ADD one attendee to a ticket (owner/co-planner only). A ticket assigned to
 * three people has been through here three times.
 *
 * IDEMPOTENT, and that is the unique index doing it rather than a read followed
 * by a write: `on conflict do nothing` on `(media_id, rsvp_id)` means two
 * planners clicking the same name at the same moment leave one row, with no
 * transaction and nothing to serialise on. "Ben is on this ticket" is the state
 * the caller asked for and it holds either way, so the second call is a 200 and
 * not a 409 — a refusal here would be the instance disagreeing with somebody
 * about something they and it both want.
 */
export async function addTicketAssignee(
  userId: string,
  slug: string,
  mediaId: string,
  rsvpId: string
): Promise<MediaItemView> {
  const { ev, item } = await assertMayAssign(userId, slug, mediaId)

  const [target] = await useDb()
    .select({ id: tables.rsvp.id })
    .from(tables.rsvp)
    .where(and(eq(tables.rsvp.id, rsvpId), eq(tables.rsvp.eventId, ev.id)))
    .limit(1)
  // An RSVP on ANOTHER trip is the same 404 as one that does not exist, and the
  // composite foreign key on `events_ticket_assignment` refuses it underneath
  // this whatever the check above does.
  if (!target) throw createError({ statusCode: 404, message: 'RSVP not found' })

  await useDb()
    .insert(tables.ticketAssignment)
    .values({ id: createId(), eventId: ev.id, mediaId: item.id, rsvpId })
    .onConflictDoNothing({ target: [tables.ticketAssignment.mediaId, tables.ticketAssignment.rsvpId] })

  return ticketAfterAssignment(item)
}

/**
 * REMOVE one attendee from a ticket (owner/co-planner only). The others stay —
 * which is the whole difference between this and the single column it replaces,
 * where "unassign" could only ever mean "nobody has this ticket now".
 *
 * Idempotent in the same way and for the same reason as the add: removing
 * somebody who is not on the ticket answers 200 with the ticket as it stands,
 * because "Ben is not on this" is the state the caller asked for. It deletes on
 * `(event_id, media_id, rsvp_id)` rather than on the pair alone, so a media id
 * from another trip cannot reach this row even if the gate above ever stopped
 * looking.
 */
export async function removeTicketAssignee(
  userId: string,
  slug: string,
  mediaId: string,
  rsvpId: string
): Promise<MediaItemView> {
  const { ev, item } = await assertMayAssign(userId, slug, mediaId)

  await useDb()
    .delete(tables.ticketAssignment)
    .where(and(
      eq(tables.ticketAssignment.eventId, ev.id),
      eq(tables.ticketAssignment.mediaId, item.id),
      eq(tables.ticketAssignment.rsvpId, rsvpId)
    ))

  return ticketAfterAssignment(item)
}

/* ------------------------- what the ticket says (#35) ---------------------- */

/** The eight things a planner may write about a ticket. Each one optional. */
export interface TicketDetailInput {
  bookingRef?: string | null
  carrier?: string | null
  seat?: string | null
  coach?: string | null
  travellerName?: string | null
  validFrom?: string | Date | null
  validUntil?: string | Date | null
  note?: string | null
}

/** '' is not a value somebody typed; it is a field they left alone. */
function trimmedOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

function instantOrNull(v: string | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Write what is printed on a ticket (owner/co-planner only, like assignment and
 * deletion — a ticket is host-managed and `server/domain/guest.ts` refuses a
 * guest even the upload).
 *
 * IT IS A REPLACE, not a merge, and the alternative was considered and dropped.
 * A merge needs three states per field — "set it", "clear it", "leave it" — and
 * over JSON those are a value, `null` and absent, which is exactly the
 * distinction a form that serialises its empty inputs cannot make. So every
 * absent field is a cleared field, one meaning per request, and the one screen
 * that writes here posts the whole set.
 *
 * WHICH IS ALSO THE ESCAPE HATCH: a detail with every field blank is a legal
 * write and leaves a row that says exactly what no row says — nobody has
 * written anything down. There is no DELETE because there is nothing a delete
 * would do that this does not, and a second verb that answers the same question
 * is a second place for the two answers to drift apart.
 *
 * NOTHING HERE IS REQUIRED and nothing ever will be. The whole point of #35 is
 * that the PDF is what gets you through the barrier: a ticket somebody uploaded
 * and never annotated must stay as usable as it was, so this refuses an empty
 * body in no way at all.
 *
 * A PENDING upload may be annotated. A planner typing the seat while 4 MB of
 * PDF goes up is doing the ordinary thing, and the row is invisible either way
 * until the upload is confirmed (`listMediaForViewer`/`listMediaForPlanner`
 * both filter on `status = 'ready'`), so there is nothing for a refusal to
 * protect.
 */
export async function setTicketDetail(
  userId: string,
  slug: string,
  mediaId: string,
  input: TicketDetailInput
): Promise<MediaItemView> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [item] = await useDb()
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, ev.id)))
    .limit(1)
  // The same 404 for "no such id" and "a media id from another trip": which of
  // the two it is, is not something this caller is entitled to learn.
  if (!item) throw createError({ statusCode: 404, message: 'Ticket not found' })
  if (item.type !== 'ticket') {
    throw createError({
      statusCode: 422,
      message: 'Only a ticket carries a booking reference and a seat — a photo or a document has neither'
    })
  }

  const values = {
    bookingRef: trimmedOrNull(input.bookingRef),
    carrier: trimmedOrNull(input.carrier),
    seat: trimmedOrNull(input.seat),
    coach: trimmedOrNull(input.coach),
    travellerName: trimmedOrNull(input.travellerName),
    validFrom: instantOrNull(input.validFrom),
    validUntil: instantOrNull(input.validUntil),
    note: trimmedOrNull(input.note)
  }

  // `media_id` is unique, so the upsert is the whole of "create or edit" — and
  // it is one statement, so two planners saving the same ticket at once cannot
  // leave two rows behind. `updatedAt` is left out deliberately: the column
  // carries `$onUpdate` and sets itself.
  const [saved] = await useDb()
    .insert(tables.ticketDetail)
    .values({ id: createId(), eventId: ev.id, mediaId: item.id, ...values })
    .onConflictDoUpdate({ target: tables.ticketDetail.mediaId, set: values })
    .returning()
  // Who it is for comes back with it (#36), for the mirror of the reason the
  // detail comes back off an assignment: this answer is what the host card
  // re-renders from, and a ticket that reported nobody because somebody typed a
  // seat number into it would read as an assignment that had been undone.
  return toView(item, saved, (await loadTicketAssignments([item.id])).get(item.id) ?? [])
}

/* ---------------------- the itinerary pin (#38) ---------------------------- */

/**
 * WHAT MAY BE PINNED TO AN ITINERARY STEP, and the rule is about what a reader
 * standing at that step needs in their hand.
 *
 * A ticket gets you through the barrier and a shared paper is the reservation
 * you show at the desk, so both belong ON the 09:14 rather than four cards
 * further down. A photo and a video are the GALLERY — the social memory of the
 * trip, browsed afterwards — and pinning one to a step would put it somewhere
 * no screen renders it: `EventTimeline.vue` draws a file and the two lines a
 * ticket says, and a photograph in that list is a download button with nothing
 * to read beside it.
 *
 * THIS IS THE NARROW READING AND IT IS DELIBERATE. `events_media.timeline_item_id`
 * accepts any media row and always has; nothing in the database stops a planner
 * pinning a photo. Widening this list later is additive and changes no stored
 * value, while shipping the wide version and discovering the gallery needs its
 * own rendering is not. The refusal below is what keeps a host from pinning
 * something that then appears nowhere.
 *
 * THE LIST ITSELF LIVES IN `shared/utils/pinned-media.ts`, because the host's
 * picker applies the same rule when it decides what to OFFER. Two copies of
 * "what may go on a step" is a picker that offers a photo and a server that
 * refuses it, which is the drift `shared/utils/` exists to stop.
 */

/**
 * Pin a ticket or a shared paper to an itinerary step, or un-pin it (`null`).
 *
 * ONE VERB FOR BOTH DIRECTIONS, because there is exactly one thing being said:
 * this item belongs to that step, or to no step. A `POST …/pin` plus a
 * `DELETE …/pin` would be two ways to write one nullable column, and the pair
 * would have to agree about what re-pinning an already-pinned item means.
 *
 * IT NEEDS NO LOCK, WHICH IS THE DIFFERENCE FROM `pinReceipt` ABOVE. That one
 * holds "at most one receipt per expense" — an invariant over OTHER rows, which
 * two concurrent writers can break without either of them seeing the other, so
 * it serialises them on the expense row. Here the invariant is "at most one
 * step per media item", and that is the column itself: a single UPDATE of a
 * single row, where the loser of a race is simply the earlier write. A step
 * carries as many pinned items as the planner puts on it, so there is nothing
 * to clear first and nothing for a second writer to trample.
 *
 * THE STEP IS CHECKED ON THE EVENT, not merely by id. `timeline_item_id` is a
 * plain foreign key to `events_timeline_item` with no composite key behind it,
 * so Postgres would happily accept a step id belonging to a DIFFERENT trip —
 * which would pin somebody's ticket to a day they cannot see and leave it
 * rendered nowhere. Same 404 for "no such step" and "a step on another trip":
 * which of the two it is, is not something this caller is entitled to learn.
 */
export async function setMediaTimelineItem(
  userId: string,
  slug: string,
  mediaId: string,
  timelineItemId: string | null
): Promise<MediaItemView> {
  const ev = await loadEventBySlug(slug)
  // The same role set the itinerary itself takes (`addTimelineItem`,
  // `moveTimelineItem`) and the same one that says who a ticket is for
  // (`assertMayAssign`): pinning is an edit to the plan, made from the plan.
  // `logistics` is not one of them, on both of those counts.
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const db = useDb()
  const [item] = await db
    .select()
    .from(tables.media)
    .where(and(eq(tables.media.id, mediaId), eq(tables.media.eventId, ev.id)))
    .limit(1)
  if (!item) throw createError({ statusCode: 404, message: 'Media not found' })
  if (item.status !== 'ready') {
    throw createError({ statusCode: 409, message: 'That upload has not finished yet' })
  }
  if (!isPinnableToTimeline(item.type)) {
    throw createError({
      statusCode: 422,
      message: 'A ticket or a shared document goes on a step of the plan — photos and videos live in the gallery'
    })
  }

  if (timelineItemId) {
    const [step] = await db
      .select({ id: tables.timelineItem.id })
      .from(tables.timelineItem)
      .where(and(eq(tables.timelineItem.id, timelineItemId), eq(tables.timelineItem.eventId, ev.id)))
      .limit(1)
    if (!step) throw createError({ statusCode: 404, message: 'That step is not on this trip' })
  }

  const [pinned] = await db
    .update(tables.media)
    .set({ timelineItemId })
    .where(and(eq(tables.media.id, item.id), eq(tables.media.eventId, ev.id)))
    .returning()
  // Zero rows is reachable: a planner may delete the file between the read
  // above and this write. A refusal, not a 500.
  if (!pinned) throw createError({ statusCode: 404, message: 'Media not found' })

  // The detail and the assignees come back with it, for the reason
  // `ticketAfterAssignment` gives: this is what a caller re-renders from, and
  // answering "nobody, nothing written on it" because somebody moved the ticket
  // onto the 09:14 would read as an assignment that had been undone.
  const [details, assignments] = await Promise.all([
    loadTicketDetails([pinned.id]),
    loadTicketAssignments([pinned.id])
  ])
  return toView(pinned, details.get(pinned.id), assignments.get(pinned.id) ?? [])
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
 * `ticket` WAS EXCLUDED FOR THAT REASON, AND SINCE #37 IT IS NOT. That
 * sentence used to read: a ticket is per-person, so pinning one to an expense
 * would publish it to the whole trip through a side door. The side door is
 * gone — `listMediaForViewer` hands every ticket on the event to anybody
 * holding the invite link, which is the same population that reads the budget,
 * so adding `ticket` here would now widen nothing either. THE EXCLUSION STANDS
 * ON A DIFFERENT FOOT, and it is `video`'s: a receipt is what you were
 * CHARGED, a ticket is what you were ISSUED, and filing a boarding pass where
 * the bill belongs answers a question nobody asked. A ticket also already has
 * two surfaces of its own — what it says (#35) and who it is for (#36) —
 * neither of which an expense row knows anything about, so a pinned one would
 * render in the budget stripped of the half that makes it useful.
 *
 * So if somebody wants `ticket` in this list, the question in front of them is
 * about MEANING and not about privacy. Do not reach for the old argument; it
 * has been spent.
 *
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
    // No assignees, and it is not a lookup that came back empty: `RECEIPT_TYPES`
    // is `photo` and `document`, the refusal above is what enforces it, and
    // neither of those is ever assigned to anybody (#36).
    return toView(pinned, null, [])
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
    // Assignees empty for the reason `pinReceipt` gives: only a photo or a
    // shared document can be a receipt, and neither is anybody's in particular.
    if (r.expenseId) out.set(r.expenseId, toView(r, null, []))
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
