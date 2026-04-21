import { eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { db } from './db'
import { icalToken } from '#server/database/schema'

/**
 * Resolve or create the iCal feed token that identifies a given attendee
 * (either a registered user or a guest email). Idempotent — returns the
 * existing token if one has been issued before.
 *
 * Email is always normalised to lowercase so that callers don't have to
 * coordinate casing. The unique index on `email` is set up on this
 * invariant; callers that write emails elsewhere (e.g. the RSVP path) also
 * lowercase before insert.
 */
export async function getOrCreateIcalToken(identity: { userId: string } | { email: string }): Promise<string> {
  const userId = 'userId' in identity ? identity.userId : null
  const email = 'email' in identity ? identity.email.toLowerCase() : null

  if (!userId && !email) {
    throw new Error('getOrCreateIcalToken requires a userId or email')
  }

  const where = userId
    ? eq(icalToken.userId, userId)
    : eq(icalToken.email, email!)

  const [existing] = await db.select().from(icalToken).where(where).limit(1)
  if (existing) return existing.token

  const token = createId()
  await db.insert(icalToken).values({
    id: createId(),
    token,
    userId,
    email
  })
  return token
}

/**
 * Look up the identity associated with an iCal feed token. Returns `null`
 * when the token is unknown.
 */
export async function resolveIcalToken(token: string): Promise<
  | { userId: string, email: null }
  | { userId: null, email: string }
  | null
> {
  const [row] = await db.select().from(icalToken).where(eq(icalToken.token, token)).limit(1)
  if (!row) return null
  if (row.userId) return { userId: row.userId, email: null }
  if (row.email) return { userId: null, email: row.email }
  return null
}
