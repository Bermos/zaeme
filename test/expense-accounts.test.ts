import { describe, expect, it } from 'vitest'
import {
  type AccountRow,
  ensureEventAccountsWithin,
  resolveCategoryAccount,
  ROUNDING,
  SEEDED_CATEGORIES,
  UNCATEGORISED
} from '../server/domain/accounts'

/**
 * The chart of accounts (#61) — the two decisions in `server/domain/accounts.ts`
 * that are pure enough to pin here, and were otherwise proved only by a built
 * server and a live Postgres.
 *
 * That gap was real and was measured: neutering `resolveCategoryAccount` so it
 * ignores both `accountId` and `category` and always answers `Uncategorised`
 * left 184 of 184 tests green and lint clean, while reddening thirteen smoke
 * checks. A function taking an array and an object and returning an element of
 * the array does not need a database to be wrong in a way somebody notices in
 * 300ms.
 */

const EVENT = 'ev_1'

function category(name: string, id = `cat_${name.toLowerCase().replace(/\s+/g, '_')}`): AccountRow {
  return { id, eventId: EVENT, kind: 'category', name, email: null, isSystem: name === UNCATEGORISED }
}

const ACCOUNTS: AccountRow[] = [
  ...SEEDED_CATEGORIES.map(n => category(n)),
  category(UNCATEGORISED),
  { id: 'acc_rounding', eventId: EVENT, kind: 'rounding', name: ROUNDING, email: null, isSystem: true },
  { id: 'm_ana', eventId: EVENT, kind: 'member', name: 'Ana', email: 'ana@e.com', isSystem: false }
]

describe('resolveCategoryAccount', () => {
  it('lands in Uncategorised when nothing is asked for', () => {
    // The whole reason `account_id` on a line can be NOT NULL: there is always
    // an answer, so the screen never has to ask.
    expect(resolveCategoryAccount(ACCOUNTS, {}).name).toBe(UNCATEGORISED)
    expect(resolveCategoryAccount(ACCOUNTS, { category: null, accountId: null }).name).toBe(UNCATEGORISED)
    expect(resolveCategoryAccount(ACCOUNTS, { category: '   ' }).name).toBe(UNCATEGORISED)
  })

  it('resolves the old enum values, which is what keeps existing clients working', () => {
    // Every Enterprise client generated from the contract before this change
    // sends one of these five strings.
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'travel' }).name).toBe('Travel')
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'accommodation' }).name).toBe('Accommodation')
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'food' }).name).toBe('Food')
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'tickets' }).name).toBe('Tickets')
    // `other` is the one that is not just a case difference: it was always the
    // absence of a category, so it has to land where an absence lands.
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'other' }).name).toBe(UNCATEGORISED)
  })

  it('matches a category by name, in any case', () => {
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'Food' }).id).toBe('cat_food')
    expect(resolveCategoryAccount(ACCOUNTS, { category: 'FOOD' }).id).toBe('cat_food')
    const ski = category('Ski pass', 'cat_ski')
    expect(resolveCategoryAccount([...ACCOUNTS, ski], { category: 'ski PASS' }).id).toBe('cat_ski')
  })

  it('takes the id when it is given, over any name beside it', () => {
    expect(resolveCategoryAccount(ACCOUNTS, { accountId: 'cat_tickets', category: 'food' }).id).toBe('cat_tickets')
  })

  it('refuses a name the event has no account for, rather than filing it anywhere', () => {
    // The alternative — falling back to Uncategorised — is the mutation that
    // makes every category silently wrong while every status code stays 2xx.
    expect(() => resolveCategoryAccount(ACCOUNTS, { category: 'Sherpas' })).toThrow(/no category called/)
    expect(() => resolveCategoryAccount(ACCOUNTS, { accountId: 'cat_nope' })).toThrow(/not a category account/)
  })

  it('refuses an account of this event that is not a category', () => {
    // A member or the rounding account is a real row with a real id, so "does
    // this id exist" is the wrong question to ask.
    expect(() => resolveCategoryAccount(ACCOUNTS, { accountId: 'm_ana' })).toThrow(/not a category account/)
    expect(() => resolveCategoryAccount(ACCOUNTS, { accountId: 'acc_rounding' })).toThrow(/not a category account/)
    expect(() => resolveCategoryAccount(ACCOUNTS, { category: 'Ana' })).toThrow(/no category called/)
    expect(() => resolveCategoryAccount(ACCOUNTS, { category: ROUNDING })).toThrow(/no category called/)
  })

  it('will not silently invent an event with no default destination', () => {
    const noDefault = ACCOUNTS.filter(a => a.name !== UNCATEGORISED)
    expect(() => resolveCategoryAccount(noDefault, {})).toThrow(/no Uncategorised account/)
  })
})

/**
 * A stand-in for the three methods `ensureEventAccountsWithin` uses, recording
 * what it would have inserted. The seeding decision is the thing under test —
 * WHICH accounts it creates given what is already there — and that is a
 * decision about an array, not about Postgres.
 */
function fakeDb(existing: AccountRow[]) {
  const inserted: Array<Record<string, unknown>> = []
  const rows = [...existing]
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => rows })
      })
    }),
    insert: () => ({
      values: (vals: Array<Record<string, unknown>>) => ({
        onConflictDoNothing: async () => {
          inserted.push(...vals)
          for (const v of vals) rows.push(v as unknown as AccountRow)
        }
      })
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined })
  }
  return { db: db as unknown as Parameters<typeof ensureEventAccountsWithin>[0], inserted }
}

describe('ensureEventAccountsWithin', () => {
  it('seeds the whole starting chart for an event that has none', async () => {
    const { db, inserted } = fakeDb([])
    await ensureEventAccountsWithin(db, EVENT)
    expect(inserted.map(a => a.name).sort()).toEqual(
      [...SEEDED_CATEGORIES, UNCATEGORISED, ROUNDING].sort()
    )
    expect(inserted.filter(a => a.isSystem).map(a => a.name).sort()).toEqual([ROUNDING, UNCATEGORISED].sort())
  })

  it('adds nothing to an event that already has its chart', async () => {
    const { db, inserted } = fakeDb(ACCOUNTS)
    await ensureEventAccountsWithin(db, EVENT)
    expect(inserted).toEqual([])
  })

  it('does NOT put back a category somebody removed', async () => {
    // The bug this rule exists for: re-seeding the four named categories on
    // every read makes removing one impossible — delete `Tickets` and the next
    // look at the budget hands it straight back, with only a smoke check that
    // asserted its absence to notice.
    const withoutTickets = ACCOUNTS.filter(a => a.name !== 'Tickets')
    const { db, inserted } = fakeDb(withoutTickets)
    await ensureEventAccountsWithin(db, EVENT)
    expect(inserted).toEqual([])
  })

  it('but always restores the two the ledger cannot work without', async () => {
    // `Uncategorised` is where a line with no category goes and `Rounding` is
    // where a residual goes. Both are `isSystem` and unremovable through the
    // API, so this only fires for a row that went missing another way.
    const { db, inserted } = fakeDb(ACCOUNTS.filter(a => a.name !== UNCATEGORISED && a.name !== ROUNDING))
    await ensureEventAccountsWithin(db, EVENT)
    expect(inserted.map(a => a.name).sort()).toEqual([ROUNDING, UNCATEGORISED].sort())
    expect(inserted.every(a => a.isSystem)).toBe(true)
  })
})
