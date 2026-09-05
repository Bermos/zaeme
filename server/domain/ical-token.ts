import { eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { tables, useDb } from './db'

/**
 * Per-attendee iCal feed token management. The pure ICS *rendering* lives in
 * `server/utils/ics.ts`; this is the events-domain credential that scopes a
 * feed to one attendee.
 */

/**
 * Resolve or create the iCal feed token for an attendee (registered user or
 * guest email). Idempotent — returns the existing token if one was issued.
 * Email is normalised to lowercase to match the unique index.
 */
export async function getOrCreateIcalToken(identity: { userId: string } | { email: string }): Promise<string> {
  const userId = 'userId' in identity ? identity.userId : null
  const email = 'email' in identity ? identity.email.toLowerCase() : null

  if (!userId && !email) {
    throw new Error('getOrCreateIcalToken requires a userId or email')
  }

  const where = userId
    ? eq(tables.icalToken.userId, userId)
    : eq(tables.icalToken.email, email!)

  const [existing] = await useDb().select().from(tables.icalToken).where(where).limit(1)
  if (existing) return existing.token

  const token = createId()
  await useDb().insert(tables.icalToken).values({ id: createId(), token, userId, email })
  return token
}

/** Look up the identity behind an iCal feed token, or null when unknown. */
export async function resolveIcalToken(token: string): Promise<
  | { userId: string, email: null }
  | { userId: null, email: string }
  | null
> {
  const [row] = await useDb().select().from(tables.icalToken).where(eq(tables.icalToken.token, token)).limit(1)
  if (!row) return null
  if (row.userId) return { userId: row.userId, email: null }
  if (row.email) return { userId: null, email: row.email }
  return null
}
