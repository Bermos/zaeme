import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { timelineItem } from '#server/database/schema'

const patchSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  startsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  endsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  type: z.enum(['transport', 'activity', 'accommodation', 'meal', 'other']).optional(),
  icon: z.string().max(100).optional().nullable(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
})

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!
  const itemId = getRouterParam(e, 'id')!
  const ev = await loadEventBySlug(slug)

  await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

  const [row] = await db
    .select()
    .from(timelineItem)
    .where(and(eq(timelineItem.id, itemId), eq(timelineItem.eventId, ev.id)))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Timeline item not found' })
  }

  if (e.method === 'PATCH') {
    const body = await readValidatedBody(e, patchSchema.parse)

    const updates: Partial<typeof timelineItem.$inferInsert> = {}
    if (body.title !== undefined) updates.title = body.title
    if (body.description !== undefined) updates.description = body.description
    if (body.startsAt !== undefined) updates.startsAt = body.startsAt ? new Date(body.startsAt) : null
    if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? new Date(body.endsAt) : null
    if (body.location !== undefined) updates.location = body.location
    if (body.type !== undefined) updates.type = body.type
    if (body.icon !== undefined) updates.icon = body.icon
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder

    if (Object.keys(updates).length === 0) {
      return { item: row }
    }

    const [updated] = await db
      .update(timelineItem)
      .set(updates)
      .where(eq(timelineItem.id, row.id))
      .returning()

    return { item: updated }
  }

  if (e.method === 'DELETE') {
    await db.delete(timelineItem).where(eq(timelineItem.id, row.id))
    return { success: true }
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
