import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { optionalAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { resolveInviteToken } from '#server/utils/invite'
import { deleteObject } from '#server/utils/r2'
import { media, rsvp } from '#server/database/schema'

const querySchema = z.object({
  rsvpToken: z.string().min(1).max(200).optional()
})

/**
 * Delete a media item + the backing R2 object.
 *
 * Permitted for:
 *   - Planners (any item — moderation).
 *   - Guests deleting items they uploaded themselves, via `?rsvpToken=`.
 */
export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  const mediaId = getRouterParam(e, 'id')!
  const ev = await loadEventBySlug(slug)
  const query = await getValidatedQuery(e, querySchema.parse)

  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, mediaId), eq(media.eventId, ev.id)))
    .limit(1)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Media not found' })
  }

  const session = await optionalAuth(e)
  if (session?.user) {
    await assertPlanner(ev.id, session.user.id)
  } else if (query.rsvpToken) {
    const { invite: inv, event: invEvent } = await resolveInviteToken(query.rsvpToken)
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

  // Remove the row first so a failed R2 delete doesn't leak a zombie record;
  // the object can be garbage-collected later out-of-band.
  await db.delete(media).where(eq(media.id, row.id))
  try {
    await deleteObject(row.storageKey)
  } catch (err) {
    console.error('[media.delete] r2 cleanup failed', err)
  }

  return { deleted: true }
})
