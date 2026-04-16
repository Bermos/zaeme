import { and, desc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { event, eventPlanner } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!

  const [parent] = await db
    .select()
    .from(event)
    .where(eq(event.slug, slug))
    .limit(1)

  if (!parent) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }

  if (parent.type !== 'series') {
    throw createError({ statusCode: 422, message: 'Event is not a series' })
  }

  // Check planner access on parent
  const [plannerRow] = await db
    .select({ role: eventPlanner.role })
    .from(eventPlanner)
    .where(and(
      eq(eventPlanner.eventId, parent.id),
      eq(eventPlanner.userId, session.user.id)
    ))
    .limit(1)

  if (!plannerRow) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }

  if (e.method === 'GET') {
    return db
      .select()
      .from(event)
      .where(eq(event.parentId, parent.id))
      .orderBy(desc(event.startsAt));
  }

  if (e.method === 'POST') {
    const schema = z.object({
      title: z.string().min(1).max(200),
      description: z.string().optional(),
      startsAt: z.string().datetime({ offset: true }).optional().nullable(),
      endsAt: z.string().datetime({ offset: true }).optional().nullable(),
      location: z.string().optional(),
      venueStation: z.string().optional()
    })

    const body = await readValidatedBody(e, schema.parse)

    const id = createId()
    const { generateUniqueSlug } = await import('../../../utils/slugify')
    const slug = await generateUniqueSlug(body.title)

    await db.transaction(async (tx) => {
      await tx.insert(event).values({
        id,
        slug,
        title: body.title,
        type: 'hosted',
        status: 'draft',
        description: body.description ?? null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        location: body.location ?? null,
        venueStation: body.venueStation ?? null,
        isPublic: parent.isPublic,
        parentId: parent.id
      })

      // Copy owner planner to episode
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
