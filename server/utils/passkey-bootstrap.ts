import { createHash, timingSafeEqual } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { useDb } from './db'
import { guestUser } from '../database/schema/auth'
import { isSetupRequired, resolveInstanceOwnerId } from './instance'
import { recordAudit } from '../domain/audit'
import { PASSKEY_RECOVER_PREFIX, PASSKEY_SETUP_PREFIX } from '../../shared/utils/passkey-context'

/**
 * How a passkey gets registered when nobody can sign in yet.
 *
 * Registering a passkey normally needs a session, and that is the rule
 * everywhere except the two moments where requiring one would be circular:
 *
 *  1. **FIRST RUN.** A fresh instance has no account, so there is nobody to be
 *     a session of. `/setup` claims the instance — and now claims it with a
 *     passkey rather than by posting an email nobody may be able to deliver.
 *
 *  2. **AN OWNER LOCKED OUT.** This instance's only way in was a magic link.
 *     An instance deployed without a mail transport — which is every instance
 *     between "it builds" and "email works" — can send that link nowhere, and
 *     its owner cannot sign in to register the passkey that would fix it. The
 *     break-glass is `ZAEME_OWNER_BOOTSTRAP_TOKEN`: a secret the OPERATOR puts
 *     in the environment, hands back once over HTTPS, and then removes.
 *
 * Both are `context` strings the browser passes to the passkey plugin's
 * registration call, and BOTH ARE DECIDED HERE, on the server, from facts the
 * browser cannot influence: whether an account exists at all, and whether a
 * secret only the environment holds was quoted correctly.
 *
 * The properties this file is responsible for:
 *
 *  - **The break-glass is absent unless deliberately installed.** No variable,
 *    no recovery — `bootstrapConfigured()` is false and every context quoting a
 *    token is refused, so the default deployment has no second door at all.
 *  - **Constant-time comparison**, hashed to a fixed length first, exactly as
 *    `service-auth.ts` does it and for the same reason.
 *  - **It resolves the OWNER and nobody else.** The token is not a login as an
 *    arbitrary account; it grants one thing, a passkey on the account that
 *    claimed this instance.
 *  - **Every use is audited**, and the token itself never appears in a row, a
 *    log line or a response.
 */

/** The environment variable holding the break-glass secret. Unset by default. */
export const BOOTSTRAP_TOKEN_ENV = 'ZAEME_OWNER_BOOTSTRAP_TOKEN'

/**
 * `setup:` claims an unclaimed instance; `owner-bootstrap:` recovers a
 * locked-out owner. The prefixes come from `shared/utils/passkey-context.ts`,
 * which is also where the browser builds them — one definition, both ends.
 */
const SETUP_PREFIX = PASSKEY_SETUP_PREFIX
const RECOVER_PREFIX = PASSKEY_RECOVER_PREFIX

/** Has the operator installed a break-glass token on this instance? */
export function bootstrapConfigured(): boolean {
  return Boolean(process.env[BOOTSTRAP_TOKEN_ENV])
}

/**
 * Constant-time comparison of a quoted token against the configured one.
 *
 * Hashing both sides to 32 bytes keeps `timingSafeEqual` off mismatched lengths
 * (it throws on those, and a throw is itself a length oracle). An unconfigured
 * instance answers `false` without comparing anything, so "no token installed"
 * and "wrong token" are the same answer from the outside.
 */
export function bootstrapTokenMatches(candidate: string | undefined | null): boolean {
  const expected = process.env[BOOTSTRAP_TOKEN_ENV]
  if (!expected || !candidate) return false
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(candidate), digest(expected))
}

export interface BootstrapContext {
  kind: 'setup' | 'recover'
  token?: string
  name?: string
  email?: string
}

/**
 * Parse the opaque `context` the browser sends with a passkey registration.
 *
 * `setup:<base64url json {name,email}>` — first run. The payload is a
 * convenience, not a credential: what makes this context acceptable is that the
 * instance has no account, which is checked against the database.
 *
 * `owner-bootstrap:<token>` — recovery. Here the payload IS the credential.
 *
 * Anything else, including a context this function cannot parse, is `null` and
 * refused by the caller. A malformed base64 payload must not throw: this runs
 * inside better-auth's request path, and an exception there is a 500 where the
 * honest answer is 401.
 */
export function parseBootstrapContext(context: string | null | undefined): BootstrapContext | null {
  if (!context) return null

  if (context.startsWith(RECOVER_PREFIX)) {
    const token = context.slice(RECOVER_PREFIX.length)
    return token ? { kind: 'recover', token } : null
  }

  if (context.startsWith(SETUP_PREFIX)) {
    const raw = context.slice(SETUP_PREFIX.length)
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') return null
      const { name, email } = parsed as { name?: unknown, email?: unknown }
      if (typeof name !== 'string' || typeof email !== 'string') return null
      if (!name.trim() || !email.includes('@')) return null
      return { kind: 'setup', name: name.trim(), email: email.trim().toLowerCase() }
    } catch {
      return null
    }
  }

  return null
}

export interface BootstrapUser {
  id: string
  name: string
  displayName: string
}

/**
 * STEP ONE, at options time: may this ceremony start, and for whom?
 *
 * The passkey plugin calls this before the browser has touched an
 * authenticator, so it MUST NOT WRITE ANYTHING. An earlier draft created the
 * owner account here, which meant pressing "Claim with a passkey" and then
 * dismissing the system prompt left the instance claimed by an account with no
 * passkey on it — the exact lock-out this whole feature exists to remove.
 *
 * So `setup` mints an id and promises nothing; the account is created in
 * `completeBootstrapRegistration` once an authenticator has actually answered.
 * The id travels inside the WebAuthn challenge, so both steps agree on it
 * without either of them storing a half-finished account.
 *
 * A REFUSAL is audited here, where it happens: somebody quoted a wrong token,
 * and that is worth a row whether or not they went on to touch a key.
 */
export async function resolveBootstrapUser(context: string | null | undefined): Promise<BootstrapUser | null> {
  const parsed = parseBootstrapContext(context)
  if (!parsed) return null

  if (parsed.kind === 'setup') {
    if (!(await isSetupRequired())) return null
    return { id: createId(), name: parsed.email!, displayName: parsed.name! }
  }

  if (!bootstrapTokenMatches(parsed.token)) {
    await recordAudit({
      actorKind: 'anonymous',
      surface: 'admin',
      method: 'POST',
      path: '/api/auth/passkey/generate-register-options',
      status: 401,
      meta: { via: 'owner-bootstrap', outcome: 'refused' }
    })
    return null
  }

  const owner = await loadOwner()
  if (!owner) return null
  return { id: owner.id, name: owner.email, displayName: owner.name }
}

/**
 * STEP TWO, after the authenticator has answered: make it real.
 *
 * Returns the user id the passkey should be attributed to, which the plugin
 * accepts in place of the one it started with. For `recover` that is the owner
 * it already resolved; for `setup` it is the account created right here, with
 * the id the ceremony was run against.
 *
 * Re-validating the context is not belt-and-braces: this runs on a separate
 * request, and the only thing tying it to the first is the challenge cookie.
 * A token withdrawn between the two steps must not still work.
 */
export async function completeBootstrapRegistration(
  // Only the id matters here — the name and display name were the browser's
  // suggestion at step one and are re-derived from the context, so the
  // parameter asks for no more than it reads.
  context: string | null | undefined,
  user: { id: string }
): Promise<{ userId: string, name?: string } | null> {
  const parsed = parseBootstrapContext(context)
  if (!parsed) return null

  if (parsed.kind === 'recover') {
    if (!bootstrapTokenMatches(parsed.token)) return null
    const owner = await loadOwner()
    if (!owner || owner.id !== user.id) return null
    await recordAudit({
      actorKind: 'owner',
      actorId: owner.id,
      actorLabel: owner.email,
      surface: 'admin',
      method: 'POST',
      path: '/api/auth/passkey/verify-registration',
      status: 200,
      meta: { via: 'owner-bootstrap', outcome: 'granted' }
    })
    return { userId: owner.id, name: 'Owner recovery passkey' }
  }

  if (!(await isSetupRequired())) return null
  return claimInstance({ id: user.id, name: parsed.name!, email: parsed.email! })
}

/** The instance owner in full — the oldest account (`server/utils/instance.ts`). */
async function loadOwner() {
  const ownerId = await resolveInstanceOwnerId()
  if (!ownerId) return null
  const [owner] = await useDb()
    .select({ id: guestUser.id, name: guestUser.name, email: guestUser.email })
    .from(guestUser)
    .where(eq(guestUser.id, ownerId))
    .limit(1)
  return owner ?? null
}

/**
 * Create the first account, which by definition owns the instance
 * (`server/utils/instance.ts` — the owner is the oldest row).
 *
 * The re-read afterwards is not paranoia about concurrency so much as about
 * ORDER: two tabs racing here would both pass `isSetupRequired()`, and the
 * loser must end up on the account the winner made rather than creating a
 * second one that owns nothing. The unique index on `email` is what makes that
 * decidable, and the oldest row is what makes the answer stable.
 */
async function claimInstance(input: { id: string, name: string, email: string }) {
  const db = useDb()
  const now = new Date()

  await db.insert(guestUser).values({
    id: input.id,
    name: input.name,
    email: input.email,
    // A passkey proves possession of an authenticator, not of a mailbox. The
    // address is a label here, so it is NOT marked verified.
    emailVerified: false,
    createdAt: now,
    updatedAt: now
  }).onConflictDoNothing({ target: guestUser.email })

  const [owner] = await db
    .select({ id: guestUser.id, name: guestUser.name, email: guestUser.email })
    .from(guestUser)
    .orderBy(asc(guestUser.createdAt))
    .limit(1)
  if (!owner) return null

  await recordAudit({
    actorKind: 'owner',
    actorId: owner.id,
    actorLabel: owner.email,
    surface: 'admin',
    method: 'POST',
    path: '/api/auth/passkey/verify-registration',
    status: 200,
    meta: { via: 'setup', outcome: 'claimed' }
  })

  return { userId: owner.id, name: 'Owner passkey' }
}
