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

/**
 * The budget as a DOUBLE-ENTRY LEDGER (#61).
 *
 * One assertion here is worth more than all the others and it is repeated on
 * every fixture below: **the lines of an entry sum to zero**, in what was
 * handed over and in what it settles for. In double-entry that single invariant
 * catches most of what you would otherwise hunt for a case at a time — a split
 * that does not cover the total, a conversion that lost a cent, a line posted
 * to the wrong side — so it is asserted in the code (`assertEntryBalances`,
 * which refuses the write) and again here, on entries built by the very
 * function the write path uses.
 *
 * Every fixture is chosen so the WRONG answer is visibly different from the
 * right one. The rounding fixture converts to a residual of exactly one cent
 * (dropping the rounding line leaves an entry that does not balance AND a total
 * that is a cent out); the category fixture posts two costs to two different
 * accounts (so "everything lands in Uncategorised" fails); and the settlement
 * fixture touches no category account at all (so a total that counted transfers
 * would be 300.00 too high).
 */

const ANA = { id: 'm_ana', name: 'Ana', email: 'ana@e.com' }
const BEN = { id: 'm_ben', name: 'Ben', email: 'ben@e.com' }
const CLEO = { id: 'm_cleo', name: 'Cleo', email: 'cleo@e.com' }
const DEE = { id: 'm_dee', name: 'Dee', email: 'dee@e.com' }
const MEMBERS = [ANA, BEN, CLEO, DEE]

const FOOD = { id: 'cat_food', name: 'Food' }
const STAY = { id: 'cat_stay', name: 'Accommodation' }
const UNCATEGORISED = { id: 'cat_uncat', name: 'Uncategorised' }
const ROUNDING = { id: 'acc_rounding', name: 'Rounding' }
const CATEGORIES = [FOOD, STAY, UNCATEGORISED]

function asView(line: LedgerLine): LedgerLineView {
  const member = MEMBERS.find(m => m.id === line.accountId)
  if (member) return { ...line, accountKind: 'member', accountName: member.name, accountEmail: member.email }
  const category = CATEGORIES.find(c => c.id === line.accountId)
  if (category) return { ...line, accountKind: 'category', accountName: category.name, accountEmail: null }
  return { ...line, accountKind: 'rounding', accountName: ROUNDING.name, accountEmail: null }
}

/** One expense, as the lines the write path really builds for it. */
function entry(o: {
  amountCents: number
  fxRate?: string
  categoryId?: string
  paidBy: { id: string }
  split: Array<{ member: { id: string, name: string, email: string }, amountCents?: number, weight?: string }>
  splitMode?: 'even' | 'exact' | 'percentage' | 'weight'
}): LedgerLineView[] {
  const fxRate = o.fxRate ?? '1'
  const resolved = resolveShares(
    o.amountCents,
    o.split.map(s => ({
      name: s.member.name,
      email: s.member.email,
      ...(s.amountCents === undefined ? {} : { amountCents: s.amountCents }),
      ...(s.weight === undefined ? {} : { weight: s.weight })
    })),
    o.splitMode ?? 'even'
  )
  const byEmail = new Map(o.split.map(s => [s.member.email, s.member.id]))
  const lines = buildEntryLines({
    amountCents: o.amountCents,
    amountBaseCents: convertCents(o.amountCents, fxRate),
    fxRate,
    payerAccountId: o.paidBy.id,
    categoryAccountId: o.categoryId ?? UNCATEGORISED.id,
    roundingAccountId: ROUNDING.id,
    shares: resolved.map(r => ({ accountId: byEmail.get(r.email)!, amountCents: r.amountCents, weight: r.weight }))
  })
  return lines.map(asView)
}

const sumSpent = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.amountCents, 0)
const sumBase = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.amountBaseCents, 0)

describe('every entry balances', () => {
  it('is the worked example from the issue, line for line', () => {
    // Ana pays 120 for dinner, split 4 ways:
    //   credit member:Ana 120 · debit category:Food 120 · credit category:Food 120
    //   debit member:Ana 30 · Ben 30 · Cleo 30 · Dee 30
    const lines = entry({
      amountCents: 12000,
      categoryId: FOOD.id,
      paidBy: ANA,
      split: MEMBERS.map(m => ({ member: m }))
    })
    expect(lines.map(l => [l.accountName, l.amountBaseCents])).toEqual([
      ['Ana', -12000],
      ['Food', 12000],
      ['Food', -12000],
      ['Ana', 3000],
      ['Ben', 3000],
      ['Cleo', 3000],
      ['Dee', 3000]
    ])
    expect(sumSpent(lines)).toBe(0)
    expect(sumBase(lines)).toBe(0)
    // The category ACCUMULATES: the cost is the debit into it, and the account's
    // own net is zero. Summing the net would report a trip that cost nothing.
    expect(computeTotalCents(lines)).toBe(12000)
  })

  it('balances for every split mode, at an awkward total and an awkward rate', () => {
    const modes = [
      { splitMode: 'even' as const, split: [{ member: ANA }, { member: BEN }, { member: CLEO }] },
      {
        splitMode: 'exact' as const,
        split: [
          { member: ANA, amountCents: 6001 },
          { member: BEN, amountCents: 3000 },
          { member: CLEO, amountCents: 998 }
        ]
      },
      {
        splitMode: 'percentage' as const,
        split: [
          { member: ANA, weight: '33.33' },
          { member: BEN, weight: '33.33' },
          { member: CLEO, weight: '33.34' }
        ]
      },
      {
        splitMode: 'weight' as const,
        split: [{ member: ANA, weight: '2' }, { member: BEN, weight: '1' }, { member: CLEO, weight: '0' }]
      }
    ]
    for (const rate of ['1', '0.9412', '0.8367', '1.1', '1.0000000001']) {
      for (const mode of modes) {
        const lines = entry({ amountCents: 9999, fxRate: rate, paidBy: ANA, ...mode })
        expect(sumSpent(lines)).toBe(0)
        expect(sumBase(lines)).toBe(0)
        // …and the member side of the entry nets to zero on its own, which is
        // what makes the balances close and a settlement plan pay off exactly.
        expect(sumBase(lines.filter(l => l.accountKind === 'member'))).toBe(0)
      }
    }
  })

  it('refuses to be written when it does not balance', () => {
    const lines = entry({ amountCents: 12000, paidBy: ANA, split: [{ member: ANA }, { member: BEN }] })
    expect(() => assertEntryBalances(lines)).not.toThrow()
    // One cent off in base only — the shape a conversion bug has.
    expect(() => assertEntryBalances(lines.map((l, i) => (i === 0 ? { ...l, amountBaseCents: l.amountBaseCents + 1 } : l)))).toThrow()
    // …and one cent off as spent only, which a base-only check would miss.
    expect(() => assertEntryBalances(lines.map((l, i) => (i === 0 ? { ...l, amountCents: l.amountCents + 1 } : l)))).toThrow()
    // Dropping a line is the other way an entry stops balancing.
    expect(() => assertEntryBalances(lines.slice(1))).toThrow()
  })
})

describe('the conversion residual posts to Rounding', () => {
  /**
   * EUR 100.00 at 0.8367, "Ana counts double" — 50.00 / 25.00 / 25.00.
   *
   *   the total converts to  10000 x 0.8367 = 8367.00 → 8367
   *   the shares convert to   5000 x 0.8367 = 4183.50 → 4184
   *                           2500 x 0.8367 = 2091.75 → 2092  (x2)
   *                           the three owe 8368, a cent more than was spent
   *
   * That cent is real. It goes to Rounding, where somebody can find it, rather
   * than being shaved off whoever happens to sort last.
   */
  const lines = entry({
    amountCents: 10000,
    fxRate: '0.8367',
    categoryId: FOOD.id,
    paidBy: ANA,
    splitMode: 'weight',
    split: [{ member: ANA, weight: '2' }, { member: BEN, weight: '1' }, { member: CLEO, weight: '1' }]
  })

  it('writes a rounding line for exactly the cents that do not reconcile', () => {
    const rounding = lines.filter(l => l.accountKind === 'rounding')
    expect(rounding.map(l => [l.amountCents, l.amountBaseCents])).toEqual([[0, 1]])
    expect(sumBase(lines)).toBe(0)
    expect(sumSpent(lines)).toBe(0)
  })

  it('debits each person their OWN share converted, not a tidied one', () => {
    const debits = lines.filter(l => l.accountKind === 'member' && l.amountBaseCents > 0)
    expect(debits.map(l => [l.accountName, l.amountCents, l.amountBaseCents])).toEqual([
      ['Ana', 5000, 4184],
      ['Ben', 2500, 2092],
      ['Cleo', 2500, 2092]
    ])
  })

  it('leaves the balances summing to zero exactly, and the plan closing', () => {
    const balances = computeBalances(lines)
    expect(balances.map(b => [b.email, b.paidCents, b.owedCents, b.netCents])).toEqual([
      ['ana@e.com', 8368, 4184, 4184],
      ['ben@e.com', 0, 2092, -2092],
      ['cleo@e.com', 0, 2092, -2092]
    ])
    expect(balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(0)
    const plan = suggestSettlements(balances)
    expect(plan.reduce((sum, p) => sum + p.amountCents, 0)).toBe(4184)
  })

  it('keeps the trip total at what was actually spent', () => {
    // 8367, not the 8368 the three of them severally owe. The difference is the
    // rounding line, and it is NOT a cost — `Rounding` is not a category.
    expect(computeTotalCents(lines)).toBe(8367)
  })

  it('writes no rounding line at all when nothing drifts', () => {
    const plain = entry({ amountCents: 12000, paidBy: ANA, split: MEMBERS.map(m => ({ member: m })) })
    expect(plain.filter(l => l.accountKind === 'rounding')).toEqual([])
  })
})

describe('the trip total is a sum over category accounts', () => {
  const stay = entry({ amountCents: 30000, categoryId: STAY.id, paidBy: ANA, split: [{ member: ANA }, { member: BEN }] })
  const food = entry({ amountCents: 12000, categoryId: FOOD.id, paidBy: BEN, split: [{ member: ANA }, { member: BEN }] })
  const loose = entry({ amountCents: 4000, paidBy: ANA, split: [{ member: ANA }, { member: BEN }] })

  it('answers "what did accommodation cost" from one account', () => {
    const all = [...stay, ...food, ...loose]
    const perAccount = (id: string) =>
      all.reduce((sum, l) => (l.accountId === id && l.amountBaseCents > 0 ? sum + l.amountBaseCents : sum), 0)
    expect(perAccount(STAY.id)).toBe(30000)
    expect(perAccount(FOOD.id)).toBe(12000)
    expect(perAccount(UNCATEGORISED.id)).toBe(4000)
    expect(computeTotalCents(all)).toBe(46000)
  })

  it('puts an expense with no category in Uncategorised, and nowhere else', () => {
    expect(loose.filter(l => l.accountKind === 'category').map(l => l.accountName))
      .toEqual(['Uncategorised', 'Uncategorised'])
  })

  /**
   * A settlement, which #28 will write: Ana hands Matthew the 150 she owes him.
   * It is an entry whose lines touch member accounts only — no category line,
   * therefore structurally not a cost, therefore excluded from the total by the
   * shape rather than by a `kind` flag somebody has to remember to set.
   */
  const settlement: LedgerLineView[] = [
    { accountId: ANA.id, amountCents: -15000, amountBaseCents: -15000, weight: null },
    { accountId: BEN.id, amountCents: 15000, amountBaseCents: 15000, weight: null }
  ].map(asView)

  it('excludes a member-to-member transfer without a discriminator', () => {
    expect(sumBase(settlement)).toBe(0)
    expect(computeTotalCents(settlement)).toBe(0)
    expect(computeTotalCents([...stay, ...food, ...loose, ...settlement])).toBe(46000)
  })

  it('and that transfer still moves the balances', () => {
    const before = computeBalances([...stay, ...food])
    const after = computeBalances([...stay, ...food, ...settlement])
    const net = (bs: ReturnType<typeof computeBalances>, email: string) => bs.find(b => b.email === email)!.netCents
    expect(net(before, 'ana@e.com')).toBe(9000)
    expect(net(after, 'ana@e.com')).toBe(9000 + 15000)
    expect(net(after, 'ben@e.com')).toBe(net(before, 'ben@e.com') - 15000)
  })
})
