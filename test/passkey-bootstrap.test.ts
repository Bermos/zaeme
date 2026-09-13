import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeRecoverContext, encodeSetupContext } from '../shared/utils/passkey-context'

/**
 * Two stand-ins, hoisted because `vi.mock` factories run before the module
 * graph does.
 *
 * `db` is a list of accounts, not a database: every query in the gate reads the
 * accounts table in insertion order, so predicates are not what these tests are
 * about — the DECISION is. `audit` is a list of rows, so a test can assert both
 * that a grant was recorded and that the token never appears in one.
 */
const { db, audit } = vi.hoisted(() => {
  interface Row { id: string, name: string, email: string, emailVerified: boolean, createdAt: Date }
  const db = {
    users: [] as Row[],
    reset() {
      this.users.length = 0
    }
  }
  const audit = { rows: [] as Record<string, unknown>[] }
  return { db, audit }
})

vi.mock('../server/utils/db', () => {
  // Enough of drizzle's builder for the gate's three statements. Every chain
  // ends at the accounts list; the gate's own ordering is what is under test.
  const rows = () => db.users
  const select = () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(rows().slice(0, 1)) }),
      orderBy: () => ({ limit: () => Promise.resolve(rows().slice(0, 1)) })
    })
  })
  const insert = () => ({
    values: (row: { id: string, name: string, email: string, emailVerified: boolean, createdAt: Date }) => ({
      onConflictDoNothing: async () => {
        if (!db.users.some(u => u.email === row.email)) db.users.push(row)
      }
    })
  })
  return { useDb: () => ({ select, insert }) }
})

vi.mock('../server/utils/instance', () => ({
  // The real definitions, over the stand-in: the owner is the oldest account,
  // and setup is required while there is none.
  isSetupRequired: async () => db.users.length === 0,
  resolveInstanceOwnerId: async () => db.users[0]?.id ?? null
}))

vi.mock('../server/domain/audit', () => ({
  recordAudit: async (entry: Record<string, unknown>) => {
    audit.rows.push(entry)
  }
}))

const {
  BOOTSTRAP_TOKEN_ENV,
  bootstrapConfigured,
  bootstrapTokenMatches,
  completeBootstrapRegistration,
  parseBootstrapContext,
  resolveBootstrapUser
} = await import('../server/utils/passkey-bootstrap')

/**
 * The bootstrap gate is the one place in zäme where a passkey can be registered
 * WITHOUT a session, so it is the one place where getting the parsing wrong
 * turns into "anybody may add a credential to the owner's account".
 *
 * These are the parts decidable without a database: the break-glass is off
 * unless installed, a quoted token is compared against the environment and
 * nothing else, and a context the browser made up parses to nothing rather than
 * to something. The database half — "a `setup:` context is refused once an
 * account exists" — is executed against a real instance by
 * `scripts/api-smoke.sh`.
 */
afterEach(() => {
  delete process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN
  audit.rows.length = 0
})

describe('the break-glass is absent unless it is installed', () => {
  it('is the variable the operator is told to set', () => {
    // `.env.example` and `/setup/recover` both name it; a rename that missed
    // one of them would leave an owner quoting a token nothing reads.
    expect(BOOTSTRAP_TOKEN_ENV).toBe('ZAEME_OWNER_BOOTSTRAP_TOKEN')
  })

  it('is not configured by default', () => {
    expect(bootstrapConfigured()).toBe(false)
  })

  it('refuses every token when nothing is installed', () => {
    expect(bootstrapTokenMatches('anything')).toBe(false)
    expect(bootstrapTokenMatches('')).toBe(false)
    expect(bootstrapTokenMatches(undefined)).toBe(false)
  })

  it('an empty variable does not install one', () => {
    process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = ''
    expect(bootstrapConfigured()).toBe(false)
    expect(bootstrapTokenMatches('')).toBe(false)
  })
})

describe('a quoted token is compared against the environment and nothing else', () => {
  it('accepts the configured token and refuses everything near it', () => {
    process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = 'correct-horse-battery-staple'
    expect(bootstrapTokenMatches('correct-horse-battery-staple')).toBe(true)
    expect(bootstrapTokenMatches('correct-horse-battery-stapl')).toBe(false)
    expect(bootstrapTokenMatches('correct-horse-battery-staple ')).toBe(false)
    expect(bootstrapTokenMatches('CORRECT-HORSE-BATTERY-STAPLE')).toBe(false)
  })

  it('does not throw on a length mismatch, which would itself be an oracle', () => {
    process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = 'short'
    expect(() => bootstrapTokenMatches('a much, much longer candidate')).not.toThrow()
    expect(bootstrapTokenMatches('a much, much longer candidate')).toBe(false)
  })
})

describe('the context is parsed, never trusted', () => {
  it('round-trips the setup context the browser builds', () => {
    const ctx = encodeSetupContext({ name: 'Ada Lovelace', email: 'Ada@Example.com' })
    expect(parseBootstrapContext(ctx)).toEqual({
      kind: 'setup',
      name: 'Ada Lovelace',
      // Lowercased here, because the events domain identifies a guest by their
      // lowercased address everywhere else.
      email: 'ada@example.com'
    })
  })

  it('round-trips the recovery context', () => {
    expect(parseBootstrapContext(encodeRecoverContext('tok'))).toEqual({ kind: 'recover', token: 'tok' })
  })

  it('refuses a context with no recognised prefix', () => {
    expect(parseBootstrapContext('admin')).toBeNull()
    expect(parseBootstrapContext('')).toBeNull()
    expect(parseBootstrapContext(null)).toBeNull()
    expect(parseBootstrapContext(undefined)).toBeNull()
  })

  it('refuses a recovery context with no token', () => {
    expect(parseBootstrapContext('owner-bootstrap:')).toBeNull()
  })

  it('refuses malformed setup payloads instead of throwing', () => {
    // A throw inside better-auth's request path is a 500 where the honest
    // answer is a refusal.
    expect(parseBootstrapContext('setup:not-base64-at-all!!')).toBeNull()
    expect(parseBootstrapContext('setup:' + Buffer.from('[]').toString('base64url'))).toBeNull()
    expect(parseBootstrapContext('setup:' + Buffer.from('{"name":"x"}').toString('base64url'))).toBeNull()
    expect(parseBootstrapContext('setup:' + Buffer.from('{"name":"  ","email":"a@b.c"}').toString('base64url'))).toBeNull()
    expect(parseBootstrapContext('setup:' + Buffer.from('{"name":"x","email":"nope"}').toString('base64url'))).toBeNull()
    expect(parseBootstrapContext('setup:' + Buffer.from('{"name":1,"email":2}').toString('base64url'))).toBeNull()
  })
})

/**
 * The gate itself, executed rather than read.
 *
 * The database is stubbed — these tests are about the DECISION, not about
 * drizzle — but every branch that matters runs: who a context resolves to, what
 * is written and when, and above all that the two steps of a ceremony are
 * independently checked. The plugin asks `resolveUser` before the browser has
 * touched an authenticator and `completeBootstrapRegistration` after, on a
 * separate request, so a token withdrawn in between must stop working.
 */
describe('the gate, executed', () => {
  beforeEach(() => {
    db.reset()
  })

  it('refuses a ceremony with no context at all', async () => {
    expect(await resolveBootstrapUser(null)).toBeNull()
    expect(await resolveBootstrapUser('nonsense')).toBeNull()
  })

  describe('first run: claiming an unclaimed instance', () => {
    const ctx = encodeSetupContext({ name: 'Ada Lovelace', email: 'ada@example.com' })

    it('writes NOTHING while the ceremony is only proposed', async () => {
      // The whole point of the two-step split: pressing the button and then
      // dismissing the system prompt must not claim the instance. It used to,
      // which left an owner account with no passkey and nobody able to sign in.
      const user = await resolveBootstrapUser(ctx)
      expect(user).not.toBeNull()
      expect(db.users).toHaveLength(0)
    })

    it('creates the owner once a key has answered, on the id the ceremony used', async () => {
      const user = (await resolveBootstrapUser(ctx))!
      const done = await completeBootstrapRegistration(ctx, user)
      expect(done).toEqual({ userId: user.id, name: 'Owner passkey' })
      expect(db.users).toEqual([
        expect.objectContaining({ id: user.id, name: 'Ada Lovelace', email: 'ada@example.com' })
      ])
    })

    it('does not mark the address verified — a passkey proves a key, not a mailbox', async () => {
      const user = (await resolveBootstrapUser(ctx))!
      await completeBootstrapRegistration(ctx, user)
      expect(db.users[0]!.emailVerified).toBe(false)
    })

    it('refuses once the instance has an owner, at both steps', async () => {
      db.users.push({ id: 'existing', name: 'Owner', email: 'owner@example.com', emailVerified: false, createdAt: new Date(0) })
      expect(await resolveBootstrapUser(ctx)).toBeNull()
      expect(await completeBootstrapRegistration(ctx, { id: 'x', name: 'x', displayName: 'x' })).toBeNull()
      expect(db.users).toHaveLength(1)
    })
  })

  describe('recovery: an owner who cannot sign in', () => {
    const owner = { id: 'owner-1', name: 'Owner', email: 'owner@example.com', emailVerified: true, createdAt: new Date(0) }

    beforeEach(() => {
      db.users.push({ ...owner })
      process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN = 'break-glass'
    })

    it('resolves the owner from the database, never from the context', async () => {
      const resolved = await resolveBootstrapUser(encodeRecoverContext('break-glass'))
      expect(resolved).toEqual({ id: 'owner-1', name: 'owner@example.com', displayName: 'Owner' })
    })

    it('refuses a wrong token, and writes nothing', async () => {
      expect(await resolveBootstrapUser(encodeRecoverContext('wrong'))).toBeNull()
      expect(await completeBootstrapRegistration(encodeRecoverContext('wrong'), owner)).toBeNull()
    })

    it('refuses a token withdrawn between the two steps', async () => {
      const user = (await resolveBootstrapUser(encodeRecoverContext('break-glass')))!
      // The operator removed the variable and redeployed while the browser sat
      // on the prompt. The second request must not still be holding the door.
      delete process.env.ZAEME_OWNER_BOOTSTRAP_TOKEN
      expect(await completeBootstrapRegistration(encodeRecoverContext('break-glass'), user)).toBeNull()
    })

    it('attributes the passkey to the owner and nobody else', async () => {
      db.users.push({ id: 'someone-else', name: 'Guest', email: 'guest@example.com', emailVerified: true, createdAt: new Date(1) })
      const done = await completeBootstrapRegistration(
        encodeRecoverContext('break-glass'),
        { id: 'someone-else', name: 'guest@example.com', displayName: 'Guest' }
      )
      // The ceremony was started against a different account. The owner is the
      // only account this token may ever add a key to, so this is a refusal
      // rather than a quiet re-attribution.
      expect(done).toBeNull()
    })

    it('records the grant', async () => {
      const user = (await resolveBootstrapUser(encodeRecoverContext('break-glass')))!
      await completeBootstrapRegistration(encodeRecoverContext('break-glass'), user)
      expect(audit.rows.at(-1)).toMatchObject({
        actorKind: 'owner',
        actorId: 'owner-1',
        surface: 'admin',
        meta: { via: 'owner-bootstrap', outcome: 'granted' }
      })
      expect(JSON.stringify(audit.rows)).not.toContain('break-glass')
    })

    it('records a refused attempt', async () => {
      await resolveBootstrapUser(encodeRecoverContext('wrong'))
      expect(audit.rows.at(-1)).toMatchObject({
        actorKind: 'anonymous',
        status: 401,
        meta: { via: 'owner-bootstrap', outcome: 'refused' }
      })
      expect(JSON.stringify(audit.rows)).not.toContain('wrong')
    })
  })
})
