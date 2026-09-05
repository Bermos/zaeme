import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tokensMatch } from '../server/utils/service-auth'
import { ApiError, apiError, toErrorBody } from '../server/utils/api-v1'

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
