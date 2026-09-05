import { createHash } from 'node:crypto'
import { type H3Event, createError } from 'h3'
import { requireGuestUser } from './auth'
import { resolveInstanceOwnerId } from './instance'
import { OWNER_ID_ENV, SERVICE_TOKEN_ENV } from './service-auth'

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

/**
 * The state of the Enterprise service credential, WITHOUT the credential.
 *
 * The admin surface has to answer "is the machine API actually wired up, and is
 * the token in my password manager the one this instance is running with?" —
 * and must answer it without ever putting the secret on a page. So it reports a
 * fingerprint: the first 12 hex of the token's SHA-256, which the owner can
 * recompute from their copy (`printf %s "$TOKEN" | sha256sum`) and compare.
 *
 * The Enterprise owner id is NOT a secret — it is an account id in another
 * system, and seeing it is how the owner checks the mapping is the right one —
 * so it is returned in full.
 *
 * There is deliberately no "rotate" button. The token is an environment
 * variable on TWO systems (ADR-0036: "rotate by replacing it in both places at
 * once"); a button that changed it here would only break the pair. Rotation is
 * a deploy, and the fingerprint is how the owner confirms it landed.
 */
export interface ServiceCredentialStatus {
  configured: boolean
  fingerprint: string | null
  ownerIdConfigured: boolean
  enterpriseOwnerId: string | null
}

export function serviceCredentialStatus(): ServiceCredentialStatus {
  const token = process.env[SERVICE_TOKEN_ENV]?.trim()
  const ownerId = process.env[OWNER_ID_ENV]?.trim()
  return {
    configured: Boolean(token),
    fingerprint: token ? createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12) : null,
    ownerIdConfigured: Boolean(ownerId),
    enterpriseOwnerId: ownerId || null
  }
}
