import { and, eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { invite } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const inviteId = getRouterParam(e, 'inviteId')!

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

  // Soft-revoke so already-issued links stop working while keeping the
  // audit trail on linked RSVPs intact.
  const [updated] = await db
    .update(invite)
    .set({ revokedAt: new Date() })
    .where(and(eq(invite.id, inviteId), eq(invite.eventId, ev.id)))
    .returning({ id: invite.id })

  if (!updated) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }

  return { success: true }
})
