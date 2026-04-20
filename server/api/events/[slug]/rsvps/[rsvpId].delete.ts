import { and, eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { rsvp } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const rsvpId = getRouterParam(e, 'rsvpId')!

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

  const [deleted] = await db
    .delete(rsvp)
    .where(and(eq(rsvp.id, rsvpId), eq(rsvp.eventId, ev.id)))
    .returning({ id: rsvp.id })

  if (!deleted) {
    throw createError({ statusCode: 404, message: 'RSVP not found' })
  }
  return { success: true }
})
