import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { isR2Configured, presignDownload } from '#server/utils/r2'
import { media, rsvp, user } from '#server/database/schema'

/**
 * List all media attached to an event.
 *
 * Access model:
 *   - Planners see everything including tickets.
 *   - Guests (identified by an `?rsvpToken=` query param) see all public
 *     photos/videos/documents plus the ticket assigned to their own RSVP.
 *   - Unauthenticated callers get 403.
 *
 * Items are returned sorted as a timeline (`takenAt`, falling back to
 * `createdAt`). Each item includes a short-lived presigned `url` so the
 * browser can load bytes directly from R2.
 */
export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  const ev = await loadEventBySlug(slug)

  const query = getQuery(e)
  const rsvpToken = typeof query.rsvpToken === 'string' ? query.rsvpToken : null

  const session = await optionalAuth(e)

  let viewerKind: 'planner' | 'guest'
  let viewerRsvpId: string | null = null

  if (session?.user) {
    await assertPlanner(ev.id, session.user.id)
    viewerKind = 'planner'
  } else if (rsvpToken) {
    // Resolve the token to a specific RSVP on *this* event.
    const { resolveInviteToken } = await import('#server/utils/invite')
    const { invite: inv, event: invEvent } = await resolveInviteToken(rsvpToken)
    if (invEvent.id !== ev.id) {
      throw createError({ statusCode: 403, message: 'Token does not belong to this event' })
    }
    const [guestRsvp] = await db
      .select({ id: rsvp.id })
      .from(rsvp)
      .where(and(eq(rsvp.eventId, ev.id), eq(rsvp.inviteId, inv.id)))
      .limit(1)
    if (!guestRsvp) {
      throw createError({ statusCode: 403, message: 'RSVP required' })
    }
    viewerKind = 'guest'
    viewerRsvpId = guestRsvp.id
  } else {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  const uploaderUser = { name: user.name, email: user.email }

  const rows = await db
    .select({
      id: media.id,
      type: media.type,
      status: media.status,
      storageKey: media.storageKey,
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      fileName: media.fileName,
      caption: media.caption,
      takenAt: media.takenAt,
      uploadedByUserId: media.uploadedByUserId,
      uploadedByRsvpId: media.uploadedByRsvpId,
      assignedRsvpId: media.assignedRsvpId,
      createdAt: media.createdAt,
      uploadedByUserName: uploaderUser.name,
      uploadedByUserEmail: uploaderUser.email
    })
    .from(media)
    .leftJoin(user, eq(media.uploadedByUserId, user.id))
    .where(and(eq(media.eventId, ev.id), eq(media.status, 'ready')))
    // Sort as a timeline: use takenAt when present, fall back to createdAt so
    // items without EXIF/metadata don't bubble to the top as NULL-first.
    .orderBy(desc(sql`coalesce(${media.takenAt}, ${media.createdAt})`), asc(media.createdAt))

  const visible = rows.filter((r) => {
    if (r.type !== 'ticket') return true
    if (viewerKind === 'planner') return true
    return r.assignedRsvpId === viewerRsvpId
  })

  const r2Ready = isR2Configured()
  const items = await Promise.all(visible.map(async row => ({
    ...row,
    url: r2Ready ? await presignDownload(row.storageKey) : null
  })))

  return { media: items }
})
