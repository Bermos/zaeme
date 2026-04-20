import { desc, eq } from 'drizzle-orm'
import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { assertPlanner, loadEventBySlug } from '#server/utils/permissions'
import { invite, rsvp, user } from '#server/database/schema'

export default defineEventHandler(async (e) => {
  const session = await requireAuth(e)
  const slug = getRouterParam(e, 'slug')!

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, session.user.id)

  const rows = await db
    .select({
      id: rsvp.id,
      status: rsvp.status,
      plusOne: rsvp.plusOne,
      plusOneName: rsvp.plusOneName,
      dietary: rsvp.dietary,
      accessibility: rsvp.accessibility,
      notes: rsvp.notes,
      guestName: rsvp.guestName,
      guestEmail: rsvp.guestEmail,
      userId: rsvp.userId,
      userName: user.name,
      userEmail: user.email,
      inviteId: rsvp.inviteId,
      inviteLabel: invite.label,
      createdAt: rsvp.createdAt,
      updatedAt: rsvp.updatedAt
    })
    .from(rsvp)
    .leftJoin(user, eq(rsvp.userId, user.id))
    .leftJoin(invite, eq(rsvp.inviteId, invite.id))
    .where(eq(rsvp.eventId, ev.id))
    .orderBy(desc(rsvp.createdAt))

  // Summary counts per status + headcount including +1s
  const summary: { yes: number, maybe: number, no: number, cheering: number, total: number, headcount: number } = {
    yes: 0, maybe: 0, no: 0, cheering: 0, total: rows.length, headcount: 0
  }
  for (const r of rows) {
    summary[r.status as 'yes' | 'maybe' | 'no' | 'cheering'] += 1
    if (r.status === 'yes' || r.status === 'cheering') {
      summary.headcount += 1 + (r.plusOne ? 1 : 0)
    }
  }

  return { rsvps: rows, summary }
})
