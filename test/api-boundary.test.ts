import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tokensMatch } from '../server/utils/service-auth'
import { serviceCredentialStatus } from '../server/utils/enterprise-link'
import { ApiError, apiError, toErrorBody } from '../server/utils/api-v1'
import { eventSlugFromPath } from '../server/domain/audit'
import { bootstrapConfigured, bootstrapTokenMatches } from '../server/utils/passkey-bootstrap'

/**
 * The two surfaces must not be able to reach each other.
 *
 * zäme has three ways in and they are deliberately unrelated credentials:
 *
 *   1. the GUEST capability URL — `/api/invites/<token>/**`, where the link IS
 *      the credential and there is no account;
 *   2. the HOST magic-link session — `/api/host/**` and `/api/me/**`, gated by
 *      a better-auth cookie;
 *   3. the MACHINE service token — `/api/v1/**`, one caller (Enterprise), one
 *      shared secret, no cookies anywhere.
 *
 * A service token that worked on the guest surface would hand Enterprise the
 * whole guest population; a guest cookie that reached `/api/v1` would hand any
 * signed-in friend the owner's machine API. Neither can happen if the two never
 * share an authenticator — so this file asserts the SEPARATION STRUCTURALLY,
 * over the source, rather than trusting that nobody wires them together later.
 *
 * The runtime half of this proof — an actual magic-link session answered 401 on
 * `/api/v1`, an actual service token answered 401 on `/api/host` — is executed
 * by `scripts/api-smoke.sh` against a booted server with a real database.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const API_ROOT = join(ROOT, 'server', 'api')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const allHandlers = walk(API_ROOT).filter(f => f.endsWith('.ts'))
const rel = (f: string) => relative(ROOT, f).split(sep).join('/')

const machineHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/v1/'))
const guestHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/invites/'))
const hostHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/host/'))
const adminHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/admin/'))

describe('the machine surface never touches the guest or host authenticator', () => {
  it('found the surfaces it is meant to be checking', () => {
    expect(machineHandlers.length).toBeGreaterThan(30)
    expect(guestHandlers.length).toBeGreaterThan(5)
    expect(hostHandlers.length).toBeGreaterThan(5)
  })

  it('no /api/v1 handler imports the better-auth session', () => {
    const offenders = machineHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /requireGuestUser|getGuestSession|utils\/auth/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/v1 handler reads a cookie', () => {
    const offenders = machineHandlers.filter(f => /getCookie|parseCookies|\bcookie\b/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('every /api/v1 handler checks the service token', () => {
    const offenders = machineHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      // `getHealth` is the ONE operation the contract marks `security: []`.
      if (rel(f) === 'server/api/v1/health.get.ts') return !/defineV1Handler/.test(src)
      // `getEventsSnapshot` cannot use the wrapper: that resolves the planner
      // from the database as part of authenticating, and the contract forbids
      // this operation to 5xx on a cold one. It checks the CREDENTIAL — which
      // needs no database — and degrades only the data.
      if (rel(f) === 'server/api/v1/snapshot.get.ts') return !/authenticateService\(event\)/.test(src)
      return !/defineServiceHandler/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])
  })

  it('the snapshot still answers 401/403 when the database is down', () => {
    // The credential half must be decidable without a database, or an outage
    // would turn every unauthenticated probe into a 200.
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    const credentialHalf = src.slice(src.indexOf('export function authenticateService'), src.indexOf('export async function requireServiceCaller'))
    expect(credentialHalf).toMatch(/tokensMatch/)
    expect(credentialHalf).not.toMatch(/resolveInstancePlanner|useDb|await/)
  })

  it('no guest or host handler imports the service token', () => {
    const offenders = [...guestHandlers, ...hostHandlers].filter(f =>
      /service-auth|requireServiceCaller|ZAEME_SERVICE_TOKEN/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the service-token module itself never reaches for a session or a cookie', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    expect(src).not.toMatch(/getCookie|parseCookies|auth\.api|getGuestSession/)
  })

  it('exempts /api/v1 from the first-run setup redirect', () => {
    // Otherwise an un-set-up instance answers the machine API with a 302 to a
    // browser bootstrap page, which no HTTP client can act on.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).toContain('\'/api/v1/\'')
  })
})

/**
 * The ADMIN surface is the fourth thing that can be reached over HTTP, and it
 * deliberately introduces no fourth credential: it is the host session plus one
 * question — is this account the one that claimed the instance
 * (`server/utils/admin.ts`). Which makes two directions worth asserting.
 *
 * INWARD: nothing but the owner gets in. Not a guest holding a capability URL,
 * not a co-planner's session, and above all not Enterprise's service token —
 * the machine API is a PEER of this surface, not a way into it. A service token
 * that reached `/api/admin` would hand the XO the instance's accounts, every
 * live invite link and the audit of its own behaviour.
 *
 * OUTWARD: the owner gate stays out of everything else. If `/api/v1` could
 * import it, the machine surface would acquire an owner-scoped mode nobody
 * declared in the contract; if the host surface used it, planning would quietly
 * become owner-only.
 *
 * The runtime half of this is executed in `scripts/api-smoke.sh`, which signs
 * in as two real accounts and checks the owner is let in and the other is not.
 */
describe('the admin surface is the owner\'s, and only the owner\'s', () => {
  it('found the admin routes it is meant to be checking', () => {
    expect(adminHandlers.length).toBeGreaterThan(10)
  })

  it('every /api/admin handler goes through the owner gate', () => {
    const offenders = adminHandlers.filter(f => !/requireOwner\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/admin handler accepts the service token', () => {
    const offenders = adminHandlers.filter(f =>
      /service-auth|requireServiceCaller|authenticateService|ZAEME_SERVICE_TOKEN|authorization/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/admin handler accepts a capability token', () => {
    // A guest's invite URL is a bearer credential for ONE event. It is not an
    // identity, and nothing on this surface may treat it as one.
    const offenders = adminHandlers.filter(f => /getRouterParam\(\s*e[^)]*,\s*'token'\s*\)/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/v1 handler imports the owner gate', () => {
    const offenders = machineHandlers.filter(f => /utils\/admin|requireOwner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the owner gate is used by the admin surface and nowhere else', () => {
    const offenders = allHandlers
      .filter(f => !rel(f).startsWith('server/api/admin/'))
      .filter(f => /requireOwner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('does NOT exempt /api/admin from the first-run setup redirect', () => {
    // The inverse of the /api/v1 rule above, and for the opposite reason: an
    // instance nobody has claimed has no owner, so its admin surface must not
    // be reachable at all — it bounces to /setup like every other page.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).not.toMatch(/'\/api\/admin/)
  })

  it('never puts the Enterprise service token on an admin page', () => {
    // The integration page reports whether the credential is configured and a
    // fingerprint of it. Not the credential.
    process.env.ZAEME_SERVICE_TOKEN = 'hunter2-the-actual-secret'
    process.env.ZAEME_ENTERPRISE_OWNER_ID = 'ent_owner'
    const status = serviceCredentialStatus()
    expect(status.configured).toBe(true)
    expect(status.enterpriseOwnerId).toBe('ent_owner')
    expect(JSON.stringify(status)).not.toContain('hunter2')
    expect(status.fingerprint).toMatch(/^[0-9a-f]{12}$/)

    delete process.env.ZAEME_SERVICE_TOKEN
    expect(serviceCredentialStatus()).toMatchObject({ configured: false, fingerprint: null })
  })
})

describe('the audit records every surface, and reads no cookie near /api/v1', () => {
  const middleware = readFileSync(join(ROOT, 'server', 'middleware', 'audit.ts'), 'utf8')

  it('bails out of the machine surface before it resolves a session', () => {
    // The edge recorder is the ONE place that may resolve a session for a
    // mutating request; if it did so for /api/v1 it would put a cookie read on
    // the machine surface's path, which is exactly what the boundary forbids.
    const guard = middleware.indexOf('path.startsWith(\'/api/v1\')')
    const session = middleware.indexOf('getGuestSession(event)')
    expect(guard).toBeGreaterThan(-1)
    expect(session).toBeGreaterThan(guard)
  })

  it('never records the auth routes, where magic-link tokens travel', () => {
    expect(middleware).toMatch(/\/api\/auth/)
  })

  it('the machine surface audits itself, from its own credential', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'service-auth.ts'), 'utf8')
    expect(src).toMatch(/recordAudit/)
    // …and still without ever looking at a session or a cookie.
    expect(src).not.toMatch(/getCookie|parseCookies|auth\.api|getGuestSession/)
  })

  it('pins an action to the event it touched', () => {
    expect(eventSlugFromPath('/api/host/events/movie-night/status')).toBe('movie-night')
    expect(eventSlugFromPath('/api/v1/events/lugano-weekend/invites')).toBe('lugano-weekend')
    expect(eventSlugFromPath('/api/admin/invites/abc/revoke')).toBeNull()
    expect(eventSlugFromPath('/api/me/invites')).toBeNull()
  })
})

describe('the service token is compared in constant time', () => {
  it('accepts only the exact token', () => {
    expect(tokensMatch('correct-horse', 'correct-horse')).toBe(true)
    expect(tokensMatch('correct-hors', 'correct-horse')).toBe(false)
    expect(tokensMatch('correct-horsf', 'correct-horse')).toBe(false)
    expect(tokensMatch('Correct-Horse', 'correct-horse')).toBe(false)
  })

  it('rejects a missing token exactly as it rejects a wrong one', () => {
    expect(tokensMatch(null, 'correct-horse')).toBe(false)
    expect(tokensMatch('', 'correct-horse')).toBe(false)
  })

  it('rejects everything when no token is configured — including the empty one', () => {
    expect(tokensMatch(null, undefined)).toBe(false)
    expect(tokensMatch('', undefined)).toBe(false)
    expect(tokensMatch('anything', undefined)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
    expect(tokensMatch('anything', '')).toBe(false)
  })

  it('never throws on a length mismatch (which would itself be a length oracle)', () => {
    expect(() => tokensMatch('a', 'a-very-much-longer-secret-indeed')).not.toThrow()
    expect(tokensMatch('a', 'a-very-much-longer-secret-indeed')).toBe(false)
  })
})

describe('every failure leaves as the contract\'s error envelope', () => {
  it('carries the machine code, the message and a request id', () => {
    const { status, body } = toErrorBody(apiError(403, 'forbidden', 'Nope.'), 'req_1')
    expect(status).toBe(403)
    expect(body).toEqual({ error: { code: 'forbidden', message: 'Nope.' }, requestId: 'req_1' })
  })

  it('carries details when there are any', () => {
    const err = new ApiError(409, 'invalid_transition', 'No.', { from: 'published', to: 'polling' })
    const { body } = toErrorBody(err, 'req_2')
    expect(body.error.details).toEqual({ from: 'published', to: 'polling' })
  })

  it('never leaks an unexpected exception\'s text to the caller', () => {
    const { status, body } = toErrorBody(new Error('DATABASE_URL=postgres://user:hunter2@db/x'), 'req_3')
    expect(status).toBe(500)
    expect(body.error.code).toBe('internal')
    expect(body.error.message).not.toMatch(/hunter2/)
  })
})

/**
 * PASSKEYS add a second SIGN-IN METHOD, and deliberately not a fourth
 * credential. What comes out of `signIn.passkey` is the same better-auth
 * session cookie a magic link produces, on the same account — so `requireOwner`,
 * `requireGuestUser` and the audit never learn a second shape, and none of the
 * separations above move.
 *
 * The one genuinely new thing is registration WITHOUT a session
 * (`server/utils/passkey-bootstrap.ts`), which exists because an instance whose
 * mail transport is not configured cannot be signed in to at all. That is a
 * door, so this block asserts where it is and where it is not.
 */
describe('passkeys are a second way in, not a second credential', () => {
  const bootstrap = readFileSync(join(ROOT, 'server', 'utils', 'passkey-bootstrap.ts'), 'utf8')

  it('nothing but the auth instance can GRANT a bootstrap registration', () => {
    // `resolveBootstrapUser` is the function that turns an opaque context into
    // an account. It belongs to better-auth's registration path and to nothing
    // else — a route handler calling it would be a second, unreviewed door.
    //
    // Two routes DO import `bootstrapConfigured`, and that is a different
    // thing: a boolean saying a token is installed, which is what points a
    // locked-out owner at /setup/recover. It grants nothing and reveals no
    // value.
    const offenders = allHandlers.filter(f => /resolveBootstrapUser|bootstrapTokenMatches/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])

    expect(readFileSync(join(ROOT, 'server', 'utils', 'auth.ts'), 'utf8')).toMatch(/resolveBootstrapUser/)
  })

  it('no /api/v1 handler mentions passkeys at all', () => {
    // The machine surface is a shared secret in a header. A WebAuthn ceremony
    // needs a browser, so anything of it near /api/v1 is a mistake.
    const offenders = machineHandlers.filter(f => /passkey|webauthn/i.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the break-glass compares in constant time and is off by default', () => {
    expect(bootstrap).toMatch(/timingSafeEqual/)
    // Both sides hashed to a fixed length first, so the comparison never throws
    // on a length mismatch — a throw is itself a length oracle.
    expect(bootstrap).toMatch(/createHash\('sha256'\)/)
    expect(bootstrapTokenMatches('anything')).toBe(false)
  })

  it('the break-glass resolves the owner, never an arbitrary account', () => {
    // The token buys a passkey on the account that claimed this instance. If it
    // could name an account, it would be a login as anybody — so the recovery
    // path reads its identity from the database and the browser's `name` and
    // `email` reach exactly one place: creating the FIRST account on an
    // instance that has none. `test/passkey-bootstrap.test.ts` executes both.
    expect(bootstrap).toMatch(/resolveInstanceOwnerId/)
    expect(bootstrap).toMatch(/const owner = await loadOwner\(\)/)

    const usesBrowserIdentity = bootstrap.split('\n').filter(l => /parsed\.(name|email)!/.test(l))
    expect(usesBrowserIdentity).toHaveLength(2)
    for (const line of usesBrowserIdentity) {
      expect(line).toMatch(/claimInstance|displayName: parsed\.name!/)
    }
  })

  it('records every use of the break-glass, granted or refused', () => {
    const uses = bootstrap.match(/recordAudit\(/g) ?? []
    expect(uses.length).toBeGreaterThanOrEqual(3)
    expect(bootstrap).toMatch(/outcome: 'refused'/)
    expect(bootstrap).toMatch(/outcome: 'granted'/)
  })

  it('never puts the break-glass token in a row, a log line or a response', () => {
    // `parsed.token` is read once, by the comparison, and must not travel.
    const afterCompare = bootstrap.slice(bootstrap.indexOf('const ownerId'))
    expect(afterCompare).not.toMatch(/parsed\.token|token/)

    const statusRoute = readFileSync(join(ROOT, 'server', 'api', 'setup', 'status.get.ts'), 'utf8')
    // /api/setup/status says a token IS installed, which is what points a
    // locked-out owner at the recovery page. It must never say what it is.
    expect(statusRoute).toMatch(/bootstrapConfigured/)
    expect(statusRoute).not.toMatch(/ZAEME_OWNER_BOOTSTRAP_TOKEN|bootstrapTokenMatches/)

    process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = 'hunter2-the-actual-secret'
    expect(JSON.stringify({ recoveryAvailable: bootstrapConfigured() })).not.toContain('hunter2')
    delete process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN
  })

  it('keeps the recovery page inside the /setup exemption', () => {
    // An owner who cannot sign in must be able to REACH the page that fixes it.
    // `/setup` is already exempt from the first-run redirect and `/setup/recover`
    // rides on that prefix — this pins the prefix rather than the exact path.
    const src = readFileSync(join(ROOT, 'server', 'middleware', 'setup.ts'), 'utf8')
    expect(src).toContain('\'/setup\'')
  })

  it('the admin security page is on the admin surface, behind the owner gate', () => {
    const route = readFileSync(join(API_ROOT, 'admin', 'security', 'index.get.ts'), 'utf8')
    expect(route).toMatch(/requireOwner\(/)
  })
})

/**
 * Nuxt's file-based router has one trap this app has already fallen into, and
 * it is invisible to every test that talks to the API instead of the pages.
 *
 * A `foo.vue` sitting BESIDE a `foo/` directory is not a sibling of what is in
 * that directory — it is their PARENT route, and a child renders only where the
 * parent puts a `<NuxtPage />`. `app/pages/setup.vue` had none, so shipping
 * `app/pages/setup/recover.vue` next to it made `/setup/recover` render the
 * parent instead: it ran `setup.vue`'s own "already claimed, go home" redirect
 * and bounced a locked-out owner to `/`. In production, with every API check
 * passing.
 */
describe('a page directory never has a same-named page beside it', () => {
  const PAGES = join(ROOT, 'app', 'pages')

  /**
   * Only the TEMPLATE counts. The first version of this searched the whole
   * file, and the comment on `setup/index.vue` explaining this very trap
   * contains the string `<NuxtPage />` — so the guard read the prose, decided
   * the parent rendered its children, and passed on the broken layout it was
   * written to catch. A rule that a comment can satisfy is not a rule.
   */
  const rendersChildren = (file: string) => {
    const src = readFileSync(file, 'utf8')
    const template = /<template>([\s\S]*)<\/template>/.exec(src)?.[1] ?? ''
    return /<NuxtPage/.test(template)
  }

  it('has no `<name>.vue` beside a `<name>/` directory that fails to render it', () => {
    const offenders: string[] = []
    const visit = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          const sibling = `${full}.vue`
          if (existsSync(sibling) && !rendersChildren(sibling)) {
            offenders.push(rel(sibling))
          }
          visit(full)
        }
      }
    }
    visit(PAGES)
    expect(offenders).toEqual([])
  })

  it('still has both setup routes, as siblings', () => {
    // The fix was `setup.vue` → `setup/index.vue`, and losing either of these
    // would lock an owner out in a different way.
    expect(existsSync(join(PAGES, 'setup', 'index.vue'))).toBe(true)
    expect(existsSync(join(PAGES, 'setup', 'recover.vue'))).toBe(true)
    expect(existsSync(join(PAGES, 'setup.vue'))).toBe(false)
  })
})

/**
 * A refusal must not read as a broken server. `resolveUser` threw a plain
 * `Error`, which better-auth renders as a 500 — and `/setup/recover` puts that
 * message in front of somebody who has just mistyped a token.
 */
describe('the bootstrap refuses with a status that means refused', () => {
  it('throws better-auth\'s APIError rather than a bare Error', () => {
    const src = readFileSync(join(ROOT, 'server', 'utils', 'auth.ts'), 'utf8')
    const passkeyBlock = src.slice(src.indexOf('passkey({'))
    expect(passkeyBlock).toMatch(/new APIError\('UNAUTHORIZED'/)
    expect(passkeyBlock).not.toMatch(/throw new Error\(/)
  })
})
