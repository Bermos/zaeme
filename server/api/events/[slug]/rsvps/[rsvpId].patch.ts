import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
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

  const schema = z.object({
    status: z.enum(['yes', 'maybe', 'no', 'cheering']).optional(),
    plusOne: z.boolean().optional(),
    plusOneName: z.string().max(200).optional().nullable(),
    dietary: z.string().max(500).optional().nullable(),
    accessibility: z.string().max(500).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
    guestName: z.string().min(1).max(200).optional().nullable(),
    guestEmail: z.email().optional().nullable()
  })

  const body = await readValidatedBody(e, schema.parse)

  if (body.status === 'cheering' && ev.type !== 'concert') {
    throw createError({ statusCode: 422, message: 'Cheering is only valid for concert events' })
  }

  const updates: Record<string, unknown> = {}
  if (body.status !== undefined) updates.status = body.status
  if (body.plusOne !== undefined) updates.plusOne = body.plusOne
  if (body.plusOneName !== undefined) updates.plusOneName = body.plusOneName
  if (body.dietary !== undefined) updates.dietary = body.dietary
  if (body.accessibility !== undefined) updates.accessibility = body.accessibility
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.guestName !== undefined) updates.guestName = body.guestName
  if (body.guestEmail !== undefined) updates.guestEmail = body.guestEmail?.toLowerCase() ?? null

  if (Object.keys(updates).length === 0) {
    const [row] = await db
      .select().from(rsvp)
      .where(and(eq(rsvp.id, rsvpId), eq(rsvp.eventId, ev.id)))
      .limit(1)
    if (!row) throw createError({ statusCode: 404, message: 'RSVP not found' })
    return row
  }

  const [updated] = await db
    .update(rsvp)
    .set(updates)
    .where(and(eq(rsvp.id, rsvpId), eq(rsvp.eventId, ev.id)))
    .returning()

  if (!updated) throw createError({ statusCode: 404, message: 'RSVP not found' })
  return updated
})
