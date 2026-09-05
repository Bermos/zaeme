import { eq, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'

/**
 * Invite/RSVP credentials and resolution. Extracted from `layers/events/server/
 * utils/invite.ts` (originally zaeme `server/utils/invite.ts`) so the zäme app
 * and the Enterprise shell resolve invites through ONE implementation
 * (ADR-0019 §5). `createError` produces the same statusCode-bearing errors the
 * H3 handlers in both apps map to HTTP.
 */

/** A cuid2 token for an invite/RSVP credential (~132 bits; treat as secret). */
export function createInviteToken(): string {
  return createId()
}

export interface ResolvedInvite {
  invite: typeof tables.invite.$inferSelect
  event: typeof tables.event.$inferSelect
}

/**
 * Resolve a public invite token into the invite + event pair, enforcing
 * revocation, expiry, use-count limits, and the event lifecycle state.
 */
export async function resolveInviteToken(token: string): Promise<ResolvedInvite> {
  const [row] = await useDb()
    .select({ invite: tables.invite, event: tables.event })
    .from(tables.invite)
    .innerJoin(tables.event, eq(tables.invite.eventId, tables.event.id))
    .where(eq(tables.invite.token, token))
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
  await useDb()
    .update(tables.invite)
    .set({ usedCount: sql`${tables.invite.usedCount} + 1` })
    .where(eq(tables.invite.id, inviteId))
}
