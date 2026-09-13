import { desc, eq } from 'drizzle-orm'
import { useDb } from './db'
import { guestPasskey } from '../database/schema/auth'

/**
 * Reading an account's registered passkeys.
 *
 * Registration, renaming and deletion are better-auth's own endpoints under
 * `/api/auth/passkey/**` — they are session-scoped, so a caller can only ever
 * touch their own keys, and reimplementing them here would add a second path to
 * the same rows with its own bugs. What better-auth has no route for is "show
 * me mine in a page", which is this.
 *
 * **The public key never leaves the database.** It is not a secret — a WebAuthn
 * public key is public by construction — but nothing in the UI needs it, and a
 * credential id in a JSON response is a needless correlation handle.
 */
export interface PasskeySummary {
  id: string
  name: string | null
  deviceType: string
  backedUp: boolean
  createdAt: Date
}

export async function listPasskeysForUser(userId: string): Promise<PasskeySummary[]> {
  return useDb()
    .select({
      id: guestPasskey.id,
      name: guestPasskey.name,
      deviceType: guestPasskey.deviceType,
      backedUp: guestPasskey.backedUp,
      createdAt: guestPasskey.createdAt
    })
    .from(guestPasskey)
    .where(eq(guestPasskey.userId, userId))
    .orderBy(desc(guestPasskey.createdAt))
}

/** How many passkeys this account has. Drives the "you have no second way in" warning. */
export async function countPasskeysForUser(userId: string): Promise<number> {
  return (await listPasskeysForUser(userId)).length
}
