import { desc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { event, eventPlanner } from '#server/database/schema'
import { generateUniqueSlug } from '#server/utils/slugify'

export default defineEventHandler(async (e) => {
  if (e.method === 'GET') {
    // List events where the user is a planner
    const session = await requireAuth(e)

    return db
      .select({
        id: event.id,
        slug: event.slug,
        title: event.title,
        type: event.type,
        status: event.status,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        location: event.location,
        isPublic: event.isPublic,
        parentId: event.parentId,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        plannerRole: eventPlanner.role
      })
      .from(event)
      .innerJoin(eventPlanner, eq(event.id, eventPlanner.eventId))
      .where(eq(eventPlanner.userId, session.user.id))
      .orderBy(desc(event.createdAt))
  }

  if (e.method === 'POST') {
    const session = await requireAuth(e)

    const schema = z.object({
      title: z.string().min(1).max(200),
      type: z.enum(['hosted', 'concert', 'series']).default('hosted'),
      description: z.string().optional(),
      startsAt: z.iso.datetime({ offset: true }).optional().nullable(),
      endsAt: z.iso.datetime({ offset: true }).optional().nullable(),
      location: z.string().optional(),
      venueStation: z.string().optional(),
      ticketUrl: z.url().optional().nullable(),
      performerNote: z.string().optional(),
      parentId: z.string().optional().nullable()
    })

    const body = await readValidatedBody(e, schema.parse)

    // Concert events are public by default
    const isPublic = body.type === 'concert'

    const id = createId()
    const slug = await generateUniqueSlug(body.title)

    await db.transaction(async (tx) => {
      await tx.insert(event).values({
        id,
        slug,
        title: body.title,
        type: body.type,
        status: 'draft',
        description: body.description ?? null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        location: body.location ?? null,
        venueStation: body.venueStation ?? null,
        ticketUrl: body.ticketUrl ?? null,
        performerNote: body.performerNote ?? null,
        isPublic,
        parentId: body.parentId ?? null
      })

      // Add creator as owner planner
      await tx.insert(eventPlanner).values({
        id: createId(),
        eventId: id,
        userId: session.user.id,
        role: 'owner'
      })
    })

    return { id, slug }
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
