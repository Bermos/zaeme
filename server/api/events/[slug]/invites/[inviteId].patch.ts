import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
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

  const schema = z.object({
    label: z.string().max(120).optional().nullable(),
    email: z.email().optional().nullable(),
    name: z.string().max(120).optional().nullable(),
    maxUses: z.number().int().positive().max(10_000).optional().nullable(),
    expiresAt: z.iso.datetime({ offset: true }).optional().nullable(),
    revoked: z.boolean().optional()
  })

  const body = await readValidatedBody(e, schema.parse)

  const updates: Record<string, unknown> = {}
  if (body.label !== undefined) updates.label = body.label
  if (body.email !== undefined) updates.email = body.email
  if (body.name !== undefined) updates.name = body.name
  if (body.maxUses !== undefined) updates.maxUses = body.maxUses
  if (body.expiresAt !== undefined) updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null
  if (body.revoked !== undefined) updates.revokedAt = body.revoked ? new Date() : null

  if (Object.keys(updates).length === 0) {
    const [row] = await db.select().from(invite).where(and(eq(invite.id, inviteId), eq(invite.eventId, ev.id))).limit(1)
    if (!row) throw createError({ statusCode: 404, message: 'Invite not found' })
    return row
  }

  const [updated] = await db
    .update(invite)
    .set(updates)
    .where(and(eq(invite.id, inviteId), eq(invite.eventId, ev.id)))
    .returning()

  if (!updated) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }
  return updated
})
