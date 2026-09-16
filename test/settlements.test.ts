import { describe, expect, it } from 'vitest'
import {
  assertEntryBalances,
  buildEntryLines,
  computeBalances,
  computeTotalCents,
  convertCents,
  resolveShares,
  suggestSettlements,
  type LedgerLine,
  type LedgerLineView
} from '../server/domain/expenses'
import { recordSettlement } from '../server/domain/settlements'
import { isSettlement } from '../shared/utils/settlement'

/**
 * SETTLING UP (#28), as arithmetic.
 *
 * Every acceptance criterion on that issue is a statement about the ledger —
 * "every balance at zero and no suggestions left", "a partial settlement
 * reduces the balance by exactly that amount", "deleting one restores the
 * balance", "the trip total excludes settlements" — and all four are decidable
 * from `buildEntryLines`, `computeBalances`, `computeTotalCents` and
 * `suggestSettlements` with no database anywhere. The half that needs one (the
 * gates, the refusals, the write actually landing) is executed against a real
 * Postgres in `scripts/api-smoke.sh`.
 *
 * THE FIXTURE IS LOPSIDED ON PURPOSE. CHF 300.00 split 50 / 150 / 100 is not
 * what any even, weighted or percentage split of that total produces by
 * accident, the two debts are different sizes, and the plan therefore has an
 * ORDER that a wrong implementation gets wrong: `suggestSettlements` walks the
 * balances by net descending, so the SMALLER debt is matched first. 1/1/1 of
 * 300 would have proved none of that.
 */

const ANA = { id: 'm_ana', name: 'Ana', email: 'ana@e.com' }
const BEN = { id: 'm_ben', name: 'Ben', email: 'ben@e.com' }
const CLEO = { id: 'm_cleo', name: 'Cleo', email: 'cleo@e.com' }
const MEMBERS = [ANA, BEN, CLEO]

const STAY = { id: 'cat_stay', name: 'Accommodation' }
const ROUNDING = { id: 'acc_rounding', name: 'Rounding' }

function asView(line: LedgerLine): LedgerLineView {
  const member = MEMBERS.find(m => m.id === line.accountId)
  if (member) return { ...line, accountKind: 'member', accountName: member.name, accountEmail: member.email }
  if (line.accountId === STAY.id) return { ...line, accountKind: 'category', accountName: STAY.name, accountEmail: null }
  return { ...line, accountKind: 'rounding', accountName: ROUNDING.name, accountEmail: null }
}

/** A COST: the lines the write path builds for an ordinary expense. */
function expense(o: {
  amountCents: number
  paidBy: { id: string }
  split: Array<{ member: typeof ANA, amountCents: number }>
}): LedgerLineView[] {
  const resolved = resolveShares(
    o.amountCents,
    o.split.map(s => ({ name: s.member.name, email: s.member.email, amountCents: s.amountCents })),
    'exact'
  )
  const byEmail = new Map(o.split.map(s => [s.member.email, s.member.id]))
  return buildEntryLines({
    amountCents: o.amountCents,
    amountBaseCents: o.amountCents,
    payerAccountId: o.paidBy.id,
    categoryAccountId: STAY.id,
    roundingAccountId: ROUNDING.id,
    shares: resolved.map(r => ({ accountId: byEmail.get(r.email)!, amountCents: r.amountCents, weight: r.weight }))
  }).map(asView)
}

/**
 * A SETTLEMENT: exactly what `recordSettlement` asks `addExpense` for — the
 * sender as the payer, the recipient as the single share, and `categoryAccountId`
 * null, which is the whole of the difference.
 */
function transfer(o: {
  from: typeof ANA
  to: typeof ANA
  amountCents: number
  fxRate?: string
}): LedgerLineView[] {
  const fxRate = o.fxRate ?? '1'
  const resolved = resolveShares(o.amountCents, [{ name: o.to.name, email: o.to.email }], 'even')
  return buildEntryLines({
    amountCents: o.amountCents,
    amountBaseCents: convertCents(o.amountCents, fxRate),
    payerAccountId: o.from.id,
    categoryAccountId: null,
    roundingAccountId: ROUNDING.id,
    shares: resolved.map(r => ({ accountId: o.to.id, amountCents: r.amountCents, weight: r.weight }))
  }).map(asView)
}

const sumSpent = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.amountCents, 0)
const sumBase = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.amountBaseCents, 0)
const net = (lines: LedgerLineView[], email: string) =>
  computeBalances(lines).find(b => b.email === email)?.netCents ?? 'no-such-person'
const plan = (lines: LedgerLineView[]) =>
  suggestSettlements(computeBalances(lines)).map(s => `${s.fromName}>${s.toName}:${s.amountCents}`)

/**
 * CHF 300.00 for the chalet, fronted by Ana, owed 50 / 150 / 100.
 *
 *   Ana   paid 300.00, owes  50.00  →  +250.00
 *   Ben   paid   0.00, owes 150.00  →  −150.00
 *   Cleo  paid   0.00, owes 100.00  →  −100.00
 */
const CHALET = expense({
  amountCents: 30000,
  paidBy: ANA,
  split: [{ member: ANA, amountCents: 5000 }, { member: BEN, amountCents: 15000 }, { member: CLEO, amountCents: 10000 }]
})

describe('a settlement is an entry, and it clears the balance it says it cleared', () => {
  it('starts from a plan that owes Ana everything, smallest debt first', () => {
    expect(net(CHALET, 'ana@e.com')).toBe(25000)
    expect(net(CHALET, 'ben@e.com')).toBe(-15000)
    expect(net(CHALET, 'cleo@e.com')).toBe(-10000)
    // The ORDER is part of the answer: the balances are sorted by net
    // descending, so the plan matches Cleo (−100.00) before Ben (−150.00).
    expect(plan(CHALET)).toEqual(['Cleo>Ana:10000', 'Ben>Ana:15000'])
  })

  it('is two lines, one credit and one debit, and no category at all', () => {
    const paid = transfer({ from: CLEO, to: ANA, amountCents: 10000 })
    // The sender is credited what they handed over, the recipient debited it.
    // The ORDER matters beyond neatness: the recipient is the entry's only
    // member DEBIT, which is what `loadBudget` projects as `shares` and what the
    // card reads to say who was paid.
    expect(paid.map(l => [l.accountName, l.amountCents, l.amountBaseCents])).toEqual([
      ['Cleo', -10000, -10000],
      ['Ana', 10000, 10000]
    ])
    expect(paid.some(l => l.accountKind === 'category')).toBe(false)
    expect(paid.some(l => l.accountKind === 'rounding')).toBe(false)
    expect(sumSpent(paid)).toBe(0)
    expect(sumBase(paid)).toBe(0)
    expect(() => assertEntryBalances(paid)).not.toThrow()
  })

  it('clears exactly the debt it names, and leaves the other one alone', () => {
    const after = [...CHALET, ...transfer({ from: CLEO, to: ANA, amountCents: 10000 })]
    expect(net(after, 'cleo@e.com')).toBe(0)
    expect(net(after, 'ben@e.com')).toBe(-15000)
    expect(net(after, 'ana@e.com')).toBe(15000)
    expect(plan(after)).toEqual(['Ben>Ana:15000'])
  })

  it('ends a trip where every suggested transfer was recorded at zero, with nothing left to suggest', () => {
    const settled = [
      ...CHALET,
      ...transfer({ from: CLEO, to: ANA, amountCents: 10000 }),
      ...transfer({ from: BEN, to: ANA, amountCents: 15000 })
    ]
    expect(computeBalances(settled).map(b => [b.email, b.netCents])).toEqual([
      ['ana@e.com', 0],
      ['ben@e.com', 0],
      ['cleo@e.com', 0]
    ])
    expect(plan(settled)).toEqual([])
  })

  it('reduces a balance by EXACTLY a partial payment, and no more', () => {
    // Ben owes 150.00 and sends 40.00. Not a fraction of the debt, not a round
    // number of it: a wrong implementation that closed the debt outright, or
    // that applied the plan's figure rather than the one typed, differs here.
    const after = [...CHALET, ...transfer({ from: BEN, to: ANA, amountCents: 4000 })]
    expect(net(after, 'ben@e.com')).toBe(-11000)
    expect(net(after, 'ana@e.com')).toBe(21000)
    expect(net(after, 'cleo@e.com')).toBe(-10000)
    expect(plan(after)).toEqual(['Cleo>Ana:10000', 'Ben>Ana:11000'])
  })

  it('turns the balance around when somebody pays MORE than they owe', () => {
    // Ben owes 150.00 and sends 200.00 — he rounded up, or paid for something
    // else. Nothing refuses it, and nothing caps it at the debt: he stops being
    // a debtor and becomes a creditor for the 50.00 he is now out, which is
    // true, and the plan starts asking Cleo to pay HIM rather than Ana.
    const after = [...CHALET, ...transfer({ from: BEN, to: ANA, amountCents: 20000 })]
    expect(net(after, 'ben@e.com')).toBe(5000)
    expect(net(after, 'ana@e.com')).toBe(5000)
    expect(net(after, 'cleo@e.com')).toBe(-10000)
    expect(plan(after)).toEqual(['Cleo>Ana:5000', 'Cleo>Ben:5000'])
  })

  it('restores the balances exactly when a settlement is removed', () => {
    // Deleting an entry deletes its lines and nothing else — so "restores" is
    // the same statement as "the balances are a plain sum over the lines that
    // are left", asserted against the figures from before it was recorded
    // rather than against a constant.
    const before = computeBalances(CHALET)
    const paid = transfer({ from: CLEO, to: ANA, amountCents: 10000 })
    const during = computeBalances([...CHALET, ...paid])
    const after = computeBalances([...CHALET, ...paid].filter(l => !paid.includes(l)))
    expect(during).not.toEqual(before)
    expect(after).toEqual(before)
    expect(suggestSettlements(after)).toEqual(suggestSettlements(before))
  })
})

describe('what the trip cost does not move when people pay each other back', () => {
  it('excludes every settlement from the total, by shape and not by a flag', () => {
    const settled = [
      ...CHALET,
      ...transfer({ from: CLEO, to: ANA, amountCents: 10000 }),
      ...transfer({ from: BEN, to: ANA, amountCents: 15000 })
    ]
    // CHF 300.00 of expenses and CHF 250.00 of transfers still reports 300.00.
    expect(computeTotalCents(CHALET)).toBe(30000)
    expect(computeTotalCents(settled)).toBe(30000)
    // …and the transfers on their own cost nothing, which is the same statement
    // from the other side: there is no category debit to sum.
    expect(computeTotalCents(transfer({ from: BEN, to: ANA, amountCents: 15000 }))).toBe(0)
  })
})

describe('a payment made in another currency is recorded like any other entry', () => {
  it('moves the balance by the CONVERTED figure, with both columns closing', () => {
    // Ben sends Ana EUR 100.00 on a CHF trip at 0.9412 — CHF 94.12 off his debt,
    // not CHF 100.00. The as-spent column closes at EUR and the base column at
    // CHF, independently, which is the invariant #61 put on every entry.
    const paid = transfer({ from: BEN, to: ANA, amountCents: 10000, fxRate: '0.9412' })
    expect(paid.map(l => [l.accountName, l.amountCents, l.amountBaseCents])).toEqual([
      ['Ben', -10000, -9412],
      ['Ana', 10000, 9412]
    ])
    expect(sumSpent(paid)).toBe(0)
    expect(sumBase(paid)).toBe(0)
    const after = [...CHALET, ...paid]
    expect(net(after, 'ben@e.com')).toBe(-15000 + 9412)
    expect(net(after, 'ana@e.com')).toBe(25000 - 9412)
    expect(computeTotalCents(after)).toBe(30000)
  })
})

describe('telling a settlement from an expense', () => {
  it('reads the shape, and treats a MISSING field as a cost', () => {
    expect(isSettlement({ categoryAccountId: null })).toBe(true)
    expect(isSettlement({ categoryAccountId: 'cat_stay' })).toBe(false)
    // The asymmetry that matters: a payload without the field at all must not
    // read as a transfer, or a budget from a client that dropped it renders as
    // nothing but payments and vanishes out of the total.
    expect(isSettlement({})).toBe(false)
    expect(isSettlement({ categoryAccountId: undefined })).toBe(false)
  })
})

describe('a payment goes between two people', () => {
  const actor = { userId: 'user_1' }

  it('refuses one somebody makes to themselves, before any of it is written', () => {
    // 422 and not a database error: the refusal is decided before `addExpense`
    // is reached, so this test proves it without a Postgres. An entry crediting
    // and debiting one account nets to zero and would clear nothing, while
    // sitting in the list looking like a payment somebody made.
    return expect(recordSettlement('evt_1', {
      fromName: 'Ana',
      fromEmail: 'Ana@E.com',
      toName: 'Ana',
      toEmail: 'ana@e.com',
      amountCents: 30000
    }, actor)).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses one with nobody on an end of it', () => {
    return expect(recordSettlement('evt_1', {
      fromName: 'Ana',
      fromEmail: '  ',
      toName: 'Ben',
      toEmail: 'ben@e.com',
      amountCents: 30000
    }, actor)).rejects.toMatchObject({ statusCode: 422 })
  })
})
