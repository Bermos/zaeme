import { asc, eq, and, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { createId } from '@paralleldrive/cuid2'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { isR2Configured, presignDownload } from '#server/utils/r2'
import { timelineItem, media } from '#server/database/schema'

const createSchema = z.object({
  title: z.string().min(1).max(300),
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
  const ev = await loadEventBySlug(slug)

  if (e.method === 'GET') {
    await assertPlanner(ev.id, session.user.id)

    const items = await db
      .select()
      .from(timelineItem)
      .where(eq(timelineItem.eventId, ev.id))
      .orderBy(asc(timelineItem.sortOrder), asc(timelineItem.startsAt), asc(timelineItem.createdAt))

    if (items.length === 0) {
      return { timeline: [] }
    }

    const itemIds = items.map(i => i.id)
    const mediaRows = await db
      .select()
      .from(media)
      .where(and(eq(media.eventId, ev.id), eq(media.status, 'ready'), inArray(media.timelineItemId, itemIds)))

    const r2Ready = isR2Configured()
    const mediaWithUrl = await Promise.all(mediaRows.map(async m => ({
      ...m,
      url: r2Ready ? await presignDownload(m.storageKey) : null
    })))

    const mediaByItem = mediaWithUrl.reduce<Record<string, typeof mediaWithUrl>>((acc, m) => {
      if (m.timelineItemId) {
        const bucket = acc[m.timelineItemId]
        if (bucket) {
          bucket.push(m)
        } else {
          acc[m.timelineItemId] = [m]
        }
      }
      return acc
    }, {})

    return {
      timeline: items.map(item => ({
        ...item,
        attachedMedia: mediaByItem[item.id] ?? []
      }))
    }
  }

  if (e.method === 'POST') {
    await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

    const body = await readValidatedBody(e, createSchema.parse)

    // Default sortOrder: append after existing items
    let sortOrder = body.sortOrder ?? 0
    if (body.sortOrder === undefined) {
      const existing = await db
        .select({ sortOrder: timelineItem.sortOrder })
        .from(timelineItem)
        .where(eq(timelineItem.eventId, ev.id))
        .orderBy(asc(timelineItem.sortOrder))
      if (existing.length > 0) {
        const last = existing[existing.length - 1]
        sortOrder = (last?.sortOrder ?? 0) + 10
      }
    }

    const [inserted] = await db
      .insert(timelineItem)
      .values({
        id: createId(),
        eventId: ev.id,
        title: body.title,
        description: body.description ?? null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        location: body.location ?? null,
        type: body.type ?? 'other',
        icon: body.icon ?? null,
        sortOrder
      })
      .returning()

    return { item: { ...inserted, attachedMedia: [] } }
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
