import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { resolveInviteToken } from '#server/utils/invite'
import { media, rsvp, timelineItem } from '#server/database/schema'

const bodySchema = z.object({
  // Either edit mode — planner session only — for ticket assignment & caption.
  caption: z.string().max(2000).optional().nullable(),
  // Ticket-only: planner assigns the ticket to a specific RSVP (pass null to unassign).
  assignedRsvpId: z.string().min(1).max(50).optional().nullable(),
  // Planner: pin/unpin this media item to a timeline item (pass null to unpin).
  timelineItemId: z.string().min(1).max(50).optional().nullable(),
  // Guest confirm path: the guest may edit the caption of their own upload
  // via `?rsvpToken=...` — passes the same token they used to upload.
  rsvpToken: z.string().min(1).max(200).optional().nullable()
})

/**
 * Update a media item.
 *
 * Planners (authenticated) can edit captions on any item and (re)assign
 * tickets to an RSVP. Guests can edit the caption of items they uploaded
 * themselves by providing the matching `rsvpToken` in the body.
 */
export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  const mediaId = getRouterParam(e, 'id')!
  const ev = await loadEventBySlug(slug)
  const body = await readValidatedBody(e, bodySchema.parse)

  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, mediaId), eq(media.eventId, ev.id)))
    .limit(1)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Media not found' })
  }

  const session = await optionalAuth(e)
  let isPlanner = false
  if (session?.user) {
    // Throws 403 if not a planner.
    await assertPlanner(ev.id, session.user.id)
    isPlanner = true
  } else if (body.rsvpToken) {
    const { invite: inv, event: invEvent } = await resolveInviteToken(body.rsvpToken)
    if (invEvent.id !== ev.id) {
      throw createError({ statusCode: 403, message: 'Token does not belong to this event' })
    }
    const [guestRsvp] = await db
      .select({ id: rsvp.id })
      .from(rsvp)
      .where(and(eq(rsvp.eventId, ev.id), eq(rsvp.inviteId, inv.id)))
      .limit(1)
    if (!guestRsvp || row.uploadedByRsvpId !== guestRsvp.id) {
      throw createError({ statusCode: 403, message: 'Forbidden' })
    }
  } else {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }

  // `assignedRsvpId` is planner-only and only meaningful for tickets.
  if (body.assignedRsvpId !== undefined) {
    if (!isPlanner) {
      throw createError({ statusCode: 403, message: 'Only planners can assign tickets' })
    }
    if (row.type !== 'ticket') {
      throw createError({ statusCode: 422, message: 'Only tickets can be assigned to attendees' })
    }
    if (body.assignedRsvpId !== null) {
      const [target] = await db
        .select({ id: rsvp.id })
        .from(rsvp)
        .where(and(eq(rsvp.id, body.assignedRsvpId), eq(rsvp.eventId, ev.id)))
        .limit(1)
      if (!target) {
        throw createError({ statusCode: 422, message: 'Target RSVP not found on this event' })
      }
    }
  }

  // `timelineItemId` is planner-only.
  if (body.timelineItemId !== undefined) {
    if (!isPlanner) {
      throw createError({ statusCode: 403, message: 'Only planners can pin media to timeline items' })
    }
    if (body.timelineItemId !== null) {
      const [target] = await db
        .select({ id: timelineItem.id })
        .from(timelineItem)
        .where(and(eq(timelineItem.id, body.timelineItemId), eq(timelineItem.eventId, ev.id)))
        .limit(1)
      if (!target) {
        throw createError({ statusCode: 422, message: 'Timeline item not found on this event' })
      }
    }
  }

  const updates: Partial<typeof media.$inferInsert> = {}
  if (body.caption !== undefined) updates.caption = body.caption
  if (body.assignedRsvpId !== undefined) updates.assignedRsvpId = body.assignedRsvpId
  if (body.timelineItemId !== undefined) updates.timelineItemId = body.timelineItemId

  if (Object.keys(updates).length === 0) {
    return { media: row }
  }

  const [updated] = await db
    .update(media)
    .set(updates)
    .where(eq(media.id, row.id))
    .returning()

  return { media: updated }
})
