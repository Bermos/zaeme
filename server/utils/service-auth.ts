import { timingSafeEqual, createHash } from 'node:crypto'
import { getRequestHeader, type H3Event } from 'h3'
import { apiError, defineV1Handler } from './api-v1'
import { resolveInstancePlanner, type InstancePlanner } from './instance'

/**
 * Authentication for the machine surface (`/api/v1`), and nothing else.
 *
 * ONE caller: the Enterprise pod, holding a service token. The token
 * authenticates the *system*; the `x-mcp-user` header says which Enterprise
 * owner the call acts for, and zäme resolves that to its own planner account.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. **Constant-time comparison.** `===` on a secret leaks its prefix through
 *     timing. Both sides are hashed to a fixed 32 bytes first so
 *     `timingSafeEqual` never sees mismatched lengths (it throws on those, and
 *     throwing is itself a length oracle).
 *  2. **A missing token and a wrong token are indistinguishable.** Both take
 *     the same path and answer the same 401 body. So does a well-formed token
 *     on an instance with no `ZAEME_SERVICE_TOKEN` configured at all.
 *  3. **Total separation from the guest surface.** Nothing here reads a cookie
 *     or a better-auth session, and no guest-surface handler imports this
 *     module. `test/api-boundary.test.ts` executes both directions.
 */

/** The environment variable holding zäme's half of the shared service token. */
export const SERVICE_TOKEN_ENV = 'ZAEME_SERVICE_TOKEN'

/**
 * The single Enterprise owner id this instance accepts in `x-mcp-user`.
 * Deliberately explicit: the contract says an unrecognised id is a 403, "never
 * a silent fallback to the owner", so an instance with no mapping configured
 * accepts nobody rather than everybody.
 */
export const OWNER_ID_ENV = 'ZAEME_ENTERPRISE_OWNER_ID'

/** The provenance headers Enterprise stamps on every call (contract §Provenance). */
export interface McpProvenance {
  /** `x-mcp-user` — the Enterprise owner the call acts for. Required. */
  user: string
  /** `x-mcp-thread` — the `xo_thread.id` that reasoned the write. */
  thread: string | null
  /** `x-mcp-model` — the model id producing the turn. */
  model: string | null
  /** `x-mcp-basis` — comma-separated user message ids. */
  basis: string[]
}

export interface ServiceCaller {
  /** The zäme planner the call acts as — this instance's owner account. */
  planner: InstancePlanner
  /** Carried, not yet acted upon; see the contract's honest note on provenance. */
  provenance: McpProvenance
}

/** Fixed-width digest so `timingSafeEqual` always compares equal lengths. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Constant-time secret comparison. Returns false — never throws — for an
 * unset expectation or an absent presented token, so every failure mode shares
 * one code path and one response.
 */
export function tokensMatch(presented: string | null, expected: string | undefined): boolean {
  // An unconfigured instance still runs the full comparison, against a sentinel
  // no bearer token can spell (it contains spaces), so "no token configured",
  // "no token sent" and "wrong token sent" cost the same and answer the same.
  const secret = expected && expected.length > 0 ? expected : '  no service token configured  '
  return timingSafeEqual(digest(presented ?? ''), digest(secret))
}

/** The bearer token from `Authorization`, or null. */
function bearerToken(event: H3Event): string | null {
  const header = getRequestHeader(event, 'authorization')
  if (!header) return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

/** One 401, whatever went wrong with the credential. */
function unauthenticated(): never {
  throw apiError(401, 'unauthenticated', 'A valid service token and an x-mcp-user header are required.')
}

function readProvenance(event: H3Event, user: string): McpProvenance {
  const basis = getRequestHeader(event, 'x-mcp-basis') ?? ''
  return {
    user,
    thread: getRequestHeader(event, 'x-mcp-thread') ?? null,
    model: getRequestHeader(event, 'x-mcp-model') ?? null,
    basis: basis.split(',').map(s => s.trim()).filter(Boolean)
  }
}

/**
 * Authenticate the Enterprise service caller and resolve the planner it acts
 * as. Throws the contract's 401 for a bad/absent credential and 403 for a good
 * token acting for an owner this instance does not know.
 */
export async function requireServiceCaller(event: H3Event): Promise<ServiceCaller> {
  if (!tokensMatch(bearerToken(event), process.env[SERVICE_TOKEN_ENV])) {
    unauthenticated()
  }

  // `x-mcp-user` is part of the credential, not of the authorisation step: the
  // contract files a missing one under 401 alongside a missing token.
  const user = getRequestHeader(event, 'x-mcp-user')?.trim()
  if (!user) unauthenticated()

  const expectedOwner = process.env[OWNER_ID_ENV]?.trim()
  if (!expectedOwner || user !== expectedOwner) {
    throw apiError(403, 'forbidden', 'This owner is not linked to a planner on this zäme instance.')
  }

  const planner = await resolveInstancePlanner()
  if (!planner) {
    throw apiError(403, 'forbidden', 'This zäme instance has no owner account yet; complete first-run setup.')
  }

  return { planner, provenance: readProvenance(event, user) }
}

/**
 * A `/api/v1` route: the contract's error envelope, plus service-token
 * authentication resolved before the handler body runs. Every operation in the
 * spec uses this except `getHealth`, which the contract marks `security: []`.
 */
export function defineServiceHandler<T>(handler: (event: H3Event, caller: ServiceCaller) => Promise<T>) {
  return defineV1Handler(async (event: H3Event) => handler(event, await requireServiceCaller(event)))
}
