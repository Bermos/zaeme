import { type H3Event, createError } from 'h3'
import { requireGuestUser } from './auth'
import { resolveInstanceOwnerId } from './instance'

/**
 * The owner gate — the ONLY authenticator for `/api/admin/**`.
 *
 * zäme has three credentials that never mix (`test/api-boundary.test.ts`); the
 * admin surface adds no fourth one. It reuses the magic-link host session and
 * then asks one further question: is this account THE OWNER of this instance —
 * the first account registered, the one that claimed it at `/setup`
 * (`server/utils/instance.ts`).
 *
 * Consequences, all deliberate:
 *
 *  - A guest session reaches `/api/me` and, if they plan something, `/api/host`.
 *    It reaches nothing under `/api/admin`: co-planners plan events, they do not
 *    administer the instance.
 *  - A capability URL is not a session at all, so it cannot reach admin either.
 *  - The Enterprise SERVICE TOKEN must not reach admin, and cannot: nothing here
 *    reads a bearer token, and no admin handler imports `service-auth`. The
 *    machine API is a peer of the admin surface, not a way into it — Enterprise
 *    drives events, it does not manage zäme's accounts, tokens or audit.
 *
 * The distinction between 401 and 403 is kept honest: signed out is "sign in",
 * signed in as somebody else is "not yours".
 */
export interface InstanceOwner {
  id: string
  email: string
  name: string
}

/** Is this account the instance owner? */
export async function isInstanceOwner(userId: string): Promise<boolean> {
  return (await resolveInstanceOwnerId()) === userId
}

/** The signed-in instance owner, a 401 without a session, or a 403 for anyone else. */
export async function requireOwner(event: H3Event): Promise<InstanceOwner> {
  const user = await requireGuestUser(event)
  if (!(await isInstanceOwner(user.id))) {
    throw createError({ statusCode: 403, message: 'This instance\'s admin surface is the owner\'s only.' })
  }
  return user
}
