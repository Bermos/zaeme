import { eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { db } from './db'
import { event, invite } from '#server/database/schema'

/**
 * Generate a cuid2 token suitable for use as an invite or RSVP credential.
 * The whole cuid is already unguessable (~132 bits of entropy) — treat it as secret.
 */
export function createInviteToken(): string {
  return createId()
}

export interface ResolvedInvite {
  invite: typeof invite.$inferSelect
  event: typeof event.$inferSelect
}

/**
 * Resolve a public invite token into the invite + event pair, enforcing
 * revocation, expiry, use-count limits, and the event lifecycle state.
 */
export async function resolveInviteToken(token: string): Promise<ResolvedInvite> {
  const [row] = await db
    .select({ invite, event })
    .from(invite)
    .innerJoin(event, eq(invite.eventId, event.id))
    .where(eq(invite.token, token))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 404, message: 'Invite not found' })
  }

  const { invite: inv, event: ev } = row

  if (inv.revokedAt) {
    throw createError({ statusCode: 410, message: 'This invite has been revoked' })
  }
  if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
    throw createError({ statusCode: 410, message: 'This invite has expired' })
  }
  if (inv.maxUses !== null && inv.usedCount >= inv.maxUses) {
    throw createError({ statusCode: 410, message: 'This invite has reached its usage limit' })
  }
  if (ev.status === 'draft' || ev.status === 'cancelled') {
    throw createError({ statusCode: 403, message: 'Event is not currently accepting RSVPs' })
  }

  return { invite: inv, event: ev }
}

/** Atomic increment of `invite.usedCount`. */
export async function bumpInviteUsage(inviteId: string): Promise<void> {
  await db
    .update(invite)
    .set({ usedCount: sql`${invite.usedCount} + 1` })
    .where(eq(invite.id, inviteId))
}
