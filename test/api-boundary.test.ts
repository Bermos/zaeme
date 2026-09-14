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
const accountHandlers = allHandlers.filter(f => rel(f).startsWith('server/api/me/'))

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

  it('no guest, host or account handler imports the service token', () => {
    const offenders = [...guestHandlers, ...hostHandlers, ...accountHandlers].filter(f =>
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

/**
 * `/api/me/**` is the ACCOUNT surface: the host session, with no planner row
 * required. It has always held the cross-event aggregation; #48 moved expense
 * WRITES onto it, because the owner decided money is recorded against a person
 * rather than against whoever holds a link.
 *
 * That move is the reason this block exists, and it cuts in two directions.
 *
 * INWARD: everything here is a session, every time. A route that forgot
 * `requireGuestUser` would be an unauthenticated write to the budget, and a
 * route that accepted a capability token instead would put the link back in
 * charge of the money by the back door.
 *
 * OUTWARD — and this is the one the move could have broken — `/api/invites/**`
 * must stay exactly what it was: the link IS the credential, and no handler
 * there may read a session. Writing the expense gate INTO an invite handler is
 * the shortcut this file exists to refuse; the surfaces are separate on
 * purpose, so the guest page can still READ the budget over the link while the
 * write needs an account.
 *
 * The runtime half — an anonymous POST answered 401, a signed-in non-participant
 * answered 403 — is executed by `scripts/api-smoke.sh` against a real server.
 */
describe('the account surface is a session, and the invite link never becomes one', () => {
  const inviteExpenseWrites = guestHandlers.filter(f => /\/expenses\//.test(rel(f)))

  it('found the account routes it is meant to be checking', () => {
    expect(accountHandlers.length).toBeGreaterThan(1)
  })

  it('every /api/me handler requires a signed-in account', () => {
    const offenders = accountHandlers.filter(f => !/requireGuestUser\(/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/me handler accepts a capability token instead', () => {
    // `[slug]` on this surface names an EVENT; a `token` router param would be
    // an invite link being read as an identity, which it is not.
    const offenders = accountHandlers.filter(f => /getRouterParam\(\s*e[^)]*,\s*'token'\s*\)/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('no /api/invites handler reads a session', () => {
    // The whole point of the capability URL is that there is no account behind
    // it. A session check here would mean the link had quietly stopped being
    // sufficient for something it still appears to offer.
    const offenders = guestHandlers.filter(f =>
      /requireGuestUser|getGuestSession|utils\/auth|assertParticipant|assertPlanner/.test(readFileSync(f, 'utf8')))
    expect(offenders.map(rel)).toEqual([])
  })

  it('the invite link no longer writes an expense, and still reads the budget', () => {
    // #48: writes moved to /api/me/events/<slug>/expenses. Reading was NOT
    // narrowed — the guest page renders the budget for anybody holding the link.
    expect(inviteExpenseWrites.map(rel)).toEqual([])
    expect(existsSync(join(API_ROOT, 'invites', '[token]', 'budget.get.ts'))).toBe(true)

    const expensePost = join(API_ROOT, 'me', 'events', '[slug]', 'expenses', 'index.post.ts')
    const expenseDelete = join(API_ROOT, 'me', 'events', '[slug]', 'expenses', '[id].delete.ts')
    expect(existsSync(expensePost)).toBe(true)
    expect(existsSync(expenseDelete)).toBe(true)
    for (const f of [expensePost, expenseDelete]) {
      expect(readFileSync(f, 'utf8')).toMatch(/AsParticipant/)
    }
  })

  it('the participant gate is decided in the domain, never in a handler', () => {
    // `assertParticipant` reads the database to answer "is this account on this
    // event". Like `assertPlanner`, it belongs beside the operation it guards,
    // so a route cannot accidentally call the write without it. Importing or
    // CALLING it is the offence — naming it in a comment, as the two expense
    // handlers do to say where their gate lives, is not.
    const offenders = allHandlers.filter((f) => {
      const src = readFileSync(f, 'utf8')
      return /import[^\n]*\bassertParticipant\b/.test(src) || /\bassertParticipant\s*\(/.test(src)
    })
    expect(offenders.map(rel)).toEqual([])

    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export async function assertParticipant/)
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/assertParticipant\(ev\.id, actor\.id\)/)
  })

  it('an expense write records the account that made it, not a typed-in email', () => {
    // The accountability the account gate buys is `created_by_user_id`. If a
    // write could still name its own author, the gate would have bought nothing.
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/createdByUserId: by\.userId\b/)
    expect(expenses).toMatch(/createdByGuestEmail: null/)
    expect(expenses).not.toMatch(/guestEmail\?:/)
  })

  it('the participant write path re-checks the event lifecycle', () => {
    // The `draft`/`cancelled` refusal used to come free with
    // `resolveInviteToken`. Moving the write off the token dropped it, and an
    // expense recorded happily against a CANCELLED trip. The rule is about the
    // event, not the link, so both paths call one guard.
    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export function assertEventOpenToGuests/)
    expect(permissions).toMatch(/'draft'.*'cancelled'/s)

    const invite = readFileSync(join(ROOT, 'server', 'domain', 'invite.ts'), 'utf8')
    expect(invite).toMatch(/assertEventOpenToGuests\(ev\)/)
    // …and the check exists in exactly one place, not two that can drift.
    expect(invite).not.toMatch(/status === 'draft'/)

    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    expect(expenses).toMatch(/assertEventOpenToGuests\(ev\)/)
  })

  it('the two expense write gates agree about `logistics`', () => {
    // `addExpenseAsPlanner` refuses a logistics planner on the host surface. If
    // the participant surface accepted one, the same account would be 403'd on
    // /api/host and 200'd on /api/me for the same verb.
    //
    // This pins the ROLE SETS and nothing else. The two surfaces still differ on
    // the event LIFECYCLE on purpose — `assertEventOpenToGuests` is a guest-side
    // rule, so a co-planner may budget a draft trip on /api/host and /api/v1
    // while a participant may not on /api/me. That asymmetry is deliberate and
    // is named in #52; do not read this test as asserting the two gates agree
    // about everything.
    const expenses = readFileSync(join(ROOT, 'server', 'domain', 'expenses.ts'), 'utf8')
    const writers = /const EXPENSE_WRITERS[^=]*=\s*\[([^\]]*)\]/.exec(expenses)?.[1] ?? ''
    expect(writers).toMatch(/'participant'/)
    expect(writers).toMatch(/'owner'/)
    expect(writers).toMatch(/'co_planner'/)
    expect(writers).not.toMatch(/'logistics'/)

    const plannerGate = /assertPlanner\(ev\.id, userId, \{ roles: \[([^\]]*)\] \}\)/.exec(expenses)?.[1] ?? ''
    expect(plannerGate).toBe('\'owner\', \'co_planner\'')
  })

  it('the invite link can say a budget EXISTS without saying what is in it', () => {
    // Two different questions, and this line has already moved twice. Who may
    // WRITE is `viewer` + `lockedReason`; who may READ THE FIGURES is
    // `showAmounts`. Collapsing them renders the expense list, the balances and
    // the settlement plan to anybody a link was forwarded to — no new
    // capability (the budget was always in the payload and `GET
    // /api/invites/[token]/budget` was always open) but a change in what the
    // page says by default to somebody who has typed nothing.
    const card = readFileSync(join(ROOT, 'app', 'components', 'BudgetCard.vue'), 'utf8')
    expect(card).toMatch(/showAmounts: boolean/)
    // Required, not optional: a new caller has to decide rather than inherit.
    expect(card).not.toMatch(/showAmounts\?:/)

    const template = /<template>([\s\S]*)<\/template>\s*$/.exec(card)?.[1] ?? ''
    expect(template).toMatch(/<template v-if="showAmounts">/)
    // The running total is a figure too, and it lives outside that block.
    expect(template).toMatch(/v-if="showAmounts"[\s\S]{0,200}budget\.totalCents/)

    // …and the guest page keeps the figures exactly where they were before #48:
    // behind an identified visitor, never behind the mere presence of a link.
    const invitePage = readFileSync(join(ROOT, 'app', 'pages', 'i', '[token].vue'), 'utf8')
    expect(invitePage).toMatch(/:show-amounts="complete \|\| !!account"/)
  })

  it('records the account surface in the audit, like every other human one', () => {
    const middleware = readFileSync(join(ROOT, 'server', 'middleware', 'audit.ts'), 'utf8')
    expect(middleware).toMatch(/'\/api\/me\/'/)
    expect(eventSlugFromPath('/api/me/events/lugano-weekend/expenses')).toBe('lugano-weekend')
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

  /**
   * Every value `actor_kind` can hold, read out of the schema rather than
   * retyped — the point of the check is that three other places agree with it.
   */
  const ACTOR_KINDS = (() => {
    const schema = readFileSync(join(ROOT, 'server', 'database', 'schema', 'audit.ts'), 'utf8')
    const list = /actorKind: text\('actor_kind', \{ enum: \[([^\]]*)\]/.exec(schema)?.[1] ?? ''
    return list.split(',').map(v => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
  })()

  it('tells a planner from a participant on the account surface', () => {
    // #51: every non-owner session used to be filed as `planner`, which was
    // true only while every session-bearing surface was /api/host. Expense
    // writes moved to /api/me (#48) and a friend on a trip is not a planner.
    expect(ACTOR_KINDS).toContain('participant')
    expect(middleware).toMatch(/findPlannerRoleBySlug/)
    // …and it is the EVENT IN THE PATH that is asked about, not the surface.
    expect(middleware).toMatch(/eventSlugFromPath\(path\)/)
  })

  it('asks that question on /api/me only, and never on the machine surface', () => {
    // /api/host and /api/admin have already asserted a planner row by the time
    // a handler runs, so paying for the lookup there would buy nothing.
    expect(middleware).toMatch(/surface !== 'me'/)
    // The per-request lookup must stay behind the /api/v1 bail-out like
    // everything else here: it reaches the database on a session's behalf, so
    // its CALL SITE (the helper is declared above the handler) comes after the
    // guard and after the session it is resolving for.
    const call = middleware.indexOf('resolveSessionActorKind(match.surface')
    expect(call).toBeGreaterThan(middleware.indexOf('path.startsWith(\'/api/v1\')'))
    expect(call).toBeGreaterThan(middleware.indexOf('getGuestSession(event)'))
  })

  it('does not let a logistics planner row outrank the handler that refused it', () => {
    // `assertParticipant` deliberately does not count `logistics` as planner
    // standing, and the host surface refuses it an expense write. If the audit
    // counted it, the log would call the caller a planner for the very request
    // the handler answered as a participant — or refused outright.
    expect(middleware).toMatch(/role !== 'logistics'/)
    const permissions = readFileSync(join(ROOT, 'server', 'domain', 'permissions.ts'), 'utf8')
    expect(permissions).toMatch(/export async function findPlannerRoleBySlug/)
    // …and the lookup must hand the ROLE back rather than a boolean, or the
    // exclusion above has nothing to test.
    expect(permissions).toMatch(/findPlannerRoleBySlug\([^)]*\): Promise<PlannerRole \| null>/)
  })

  it('never calls a session a participant of an event the path does not name', () => {
    // There is no mutating /api/me route without a slug today. The day one
    // arrives (`PATCH /api/me/profile`), `participant` would be a claim about
    // an event that is not in the request.
    expect(ACTOR_KINDS).toContain('account')
    expect(middleware).toMatch(/if \(!slug\) return 'account'/)
  })

  it('the admin filter and the audit page know every kind there is', () => {
    // A kind missing from any of the three is a category the owner silently
    // cannot see, or one that silently wears somebody else's badge.
    const route = readFileSync(join(ROOT, 'server', 'api', 'admin', 'audit', 'index.get.ts'), 'utf8')
    for (const kind of ACTOR_KINDS) expect(route).toContain(`'${kind}'`)

    const page = readFileSync(join(ROOT, 'app', 'pages', 'admin', 'audit.vue'), 'utf8')
    const items = /const ACTOR_ITEMS = \[([\s\S]*?)\n\]/.exec(page)?.[1] ?? ''
    for (const kind of ACTOR_KINDS) expect(items).toContain(`value: '${kind}'`)

    // The badge map falls back to `primary`, which is the PLANNER's colour — so
    // a kind missing here reads as a planner at a glance, which is the exact
    // failure this whole change exists to fix.
    const colors = /const ACTOR_COLORS[^=]*= \{([\s\S]*?)\n\}/.exec(page)?.[1] ?? ''
    expect(colors).not.toBe('')
    for (const kind of ACTOR_KINDS) expect(colors).toContain(`${kind}:`)
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
