import { desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { createInviteToken } from '#server/utils/invite'
import { invite, rsvp } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!

  const ev = await loadEventBySlug(slug)

  if (e.method === 'GET') {
    await assertPlanner(ev.id, session.user.id)

    return db
      .select({
        id: invite.id,
        token: invite.token,
        label: invite.label,
        email: invite.email,
        name: invite.name,
        maxUses: invite.maxUses,
        usedCount: invite.usedCount,
        expiresAt: invite.expiresAt,
        revokedAt: invite.revokedAt,
        createdAt: invite.createdAt,
        rsvpCount: sql<number>`(
          select count(*)::int from ${rsvp} where ${rsvp.inviteId} = ${invite.id}
        )`
      })
      .from(invite)
      .where(eq(invite.eventId, ev.id))
      .orderBy(desc(invite.createdAt))
  }

  if (e.method === 'POST') {
    await assertPlanner(ev.id, session.user.id, { roles: ['owner', 'co_planner'] })

    const schema = z.object({
      label: z.string().max(120).optional().nullable(),
      email: z.email().optional().nullable(),
      name: z.string().max(120).optional().nullable(),
      maxUses: z.number().int().positive().max(10_000).optional().nullable(),
      expiresAt: z.iso.datetime({ offset: true }).optional().nullable()
    })

    const body = await readValidatedBody(e, schema.parse)

    const [inserted] = await db
      .insert(invite)
      .values({
        id: createInviteToken(),
        eventId: ev.id,
        token: createInviteToken(),
        label: body.label ?? null,
        email: body.email ?? null,
        name: body.name ?? null,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        createdByUserId: session.user.id
      })
      .returning()

    return inserted
  }

  throw createError({ statusCode: 405, message: 'Method not allowed' })
})
