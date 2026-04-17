import { eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { db } from '#server/utils/db'
import { requirePlanner } from '#server/utils/planner'
import { eventInvite } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!

  if (e.method === 'GET') {
    // Owner and co_planner can view the invite; logistics does not need it.
    const { eventRow } = await requirePlanner(e, slug, {
      allowedRoles: ['owner', 'co_planner']
    })

    const [existing] = await db
      .select()
      .from(eventInvite)
      .where(eq(eventInvite.eventId, eventRow.id))
      .limit(1)

    return existing ?? null
  }

  if (e.method === 'POST') {
    // Create-or-rotate. Only owner/co_planner can mint invite tokens.
    const { eventRow } = await requirePlanner(e, slug, {
      allowedRoles: ['owner', 'co_planner']
    })

    const token = createId()

    const [existing] = await db
      .select({ id: eventInvite.id })
      .from(eventInvite)
      .where(eq(eventInvite.eventId, eventRow.id))
      .limit(1)

    if (existing) {
      const [updated] = await db
        .update(eventInvite)
        .set({ token })
        .where(eq(eventInvite.id, existing.id))
        .returning()
      return updated
    }

    const [inserted] = await db
      .insert(eventInvite)
      .values({
        id: createId(),
        eventId: eventRow.id,
        token
      })
      .returning()
    return inserted
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
