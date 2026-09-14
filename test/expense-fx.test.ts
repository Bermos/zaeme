import { describe, expect, it } from 'vitest'
import {
  apportionCents,
  assertEntryBalances,
  buildEntryLines,
  computeBalances,
  convertCents,
  MAX_CENTS,
  resolveShares,
  splitEvenlyCents,
  suggestSettlements,
  type LedgerLineView
} from '../server/domain/expenses'

/**
 * The arithmetic of a mixed-currency budget (#25).
 *
 * `events_expense.currency` was stored, typed and rendered for months while
 * `computeBalances` summed `amountCents` across every row whatever it said —
 * one €120 dinner on a CHF trip went in as 12000 CHF cents. The column existed;
 * the feature did not.
 *
 * So these are tests about VALUES, not about shape. The end-to-end half — the
 * same numbers through a real Postgres and a real HTTP handler — is in
 * `scripts/api-smoke.sh`, which CI runs; what is here is the pure arithmetic
 * those routes delegate to, where a wrong answer is cheapest to see.
 */

/**
 * The accounts one imaginary event has. Real ids come from `events_account`;
 * what matters here is that a line names one, always, and that the sums below
 * are over accounts rather than over a name repeated on every row.
 */
const MEMBERS: Record<string, { id: string, name: string }> = {
  'a@e.com': { id: 'm_a', name: 'A' },
  'b@e.com': { id: 'm_b', name: 'B' },
  'c@e.com': { id: 'm_c', name: 'C' }
}
const CATEGORY = { id: 'cat_uncategorised', name: 'Uncategorised' }
const ROUNDING = { id: 'acc_rounding', name: 'Rounding' }

function asView(line: { accountId: string, amountCents: number, amountBaseCents: number, weight: string | null }): LedgerLineView {
  const member = Object.entries(MEMBERS).find(([, m]) => m.id === line.accountId)
  if (member) {
    return { ...line, accountKind: 'member', accountName: member[1].name, accountEmail: member[0] }
  }
  const system = line.accountId === ROUNDING.id ? ROUNDING : CATEGORY
  return {
    ...line,
    accountKind: line.accountId === ROUNDING.id ? 'rounding' : 'category',
    accountName: system.name,
    accountEmail: null
  }
}

/**
 * One expense, as the lines it really becomes — built by the function the write
 * path uses, not by hand. A fixture assembled by hand would keep agreeing with
 * itself after `buildEntryLines` stopped being right.
 */
function entryLines(o: {
  amountCents: number
  fxRate: string
  paidByEmail: string
  shares: Array<{ email: string, amountCents: number }>
}): LedgerLineView[] {
  const lines = buildEntryLines({
    amountCents: o.amountCents,
    amountBaseCents: convertCents(o.amountCents, o.fxRate),
    payerAccountId: MEMBERS[o.paidByEmail]!.id,
    categoryAccountId: CATEGORY.id,
    roundingAccountId: ROUNDING.id,
    shares: o.shares.map(s => ({ accountId: MEMBERS[s.email]!.id, amountCents: s.amountCents, weight: null }))
  })
  assertEntryBalances(lines)
  return lines.map(asView)
}

describe('convertCents', () => {
  it('multiplies money by a decimal rate without floating point', () => {
    expect(convertCents(12000, '0.9412')).toBe(11294)
    // 12000 * 0.9412 = 11294.4 in exact decimal. The float product is
    // 11294.399999999998, which `Math.round` happens to survive and
    // `Math.floor` does not — so the arithmetic is done in BigInt over the
    // rate's own scale rather than trusted to a double.
    expect(convertCents(1, '1.005')).toBe(1)
    expect(convertCents(100, '1.005')).toBe(101)
  })

  it('rounds half up, at any scale', () => {
    expect(convertCents(1, '0.5')).toBe(1)
    expect(convertCents(3, '0.5')).toBe(2)
    expect(convertCents(10, '0.25')).toBe(3)
    expect(convertCents(1000, '1.0000000001')).toBe(1000)
  })

  it('is the identity at rate 1', () => {
    expect(convertCents(999_999, '1')).toBe(999_999)
    expect(convertCents(0, '1')).toBe(0)
  })

  it('refuses a rate that is not a positive decimal', () => {
    expect(() => convertCents(100, '0')).toThrow()
    expect(() => convertCents(100, '-1')).toThrow()
    expect(() => convertCents(100, 'abc')).toThrow()
    expect(() => convertCents(100, '')).toThrow()
  })

  it('refuses a rate the column could not store as written', () => {
    // `numeric(20, 10)` would ROUND an eleventh decimal on the way in while
    // `amountBaseCents` was computed at full precision — leaving a row whose
    // own `amountCents x fxRate = amountBaseCents` is false, silently.
    expect(() => convertCents(100, '1.12345678901')).toThrow()
    expect(convertCents(100, '1.1234567890')).toBe(112)
    expect(() => convertCents(100, '9999999999')).toThrow()
  })

  it('refuses a product that would overrun the cents column', () => {
    // Both halves used to escape as an unhandled Postgres 500 (`integer out of
    // range`) from a handler whose 422 body already had a message field.
    expect(() => convertCents(1000, '999999999')).toThrow()
    expect(convertCents(MAX_CENTS, '1')).toBe(MAX_CENTS)
    expect(() => convertCents(MAX_CENTS, '1.001')).toThrow()
    // …but a rate that rounds back down to the ceiling still fits.
    expect(convertCents(MAX_CENTS, '1.0000000001')).toBe(MAX_CENTS)
  })
})

describe('apportionCents', () => {
  it('re-expresses a split so it sums to the converted total EXACTLY', () => {
    // EUR 100.00 three ways is 3334/3333/3333; at 0.9412 the total converts to
    // 9412, and three independent conversions would give 3138+3137+3137 = 9412
    // only by luck. This one is guaranteed.
    const shares = splitEvenlyCents(10000, 3)
    expect(shares).toEqual([3334, 3333, 3333])
    const base = apportionCents(shares, 10000, convertCents(10000, '0.9412'))
    expect(base).toEqual([3138, 3137, 3137])
    expect(base.reduce((a, b) => a + b, 0)).toBe(9412)
  })

  it('holds for every split size at an awkward rate', () => {
    for (let n = 1; n <= 17; n++) {
      const total = 99_999
      const shares = splitEvenlyCents(total, n)
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total)
      const converted = convertCents(total, '0.836719')
      const base = apportionCents(shares, total, converted)
      expect(base).toHaveLength(n)
      expect(base.reduce((a, b) => a + b, 0)).toBe(converted)
      expect(base.every(v => v >= 0)).toBe(true)
    }
  })

  it('keeps explicit shares proportional, including a zero one', () => {
    const shares = resolveShares(10000, [
      { name: 'A', email: 'a@e.com', amountCents: 5000 },
      { name: 'B', email: 'b@e.com', amountCents: 0 },
      { name: 'C', email: 'c@e.com' }
    ]).map(s => s.amountCents)
    expect(shares).toEqual([5000, 0, 5000])
    const base = apportionCents(shares, 10000, 9412)
    expect(base).toEqual([4706, 0, 4706])
  })

  it('is the identity when nothing converts', () => {
    expect(apportionCents([3334, 3333, 3333], 10000, 10000)).toEqual([3334, 3333, 3333])
  })
})

describe('balances are computed in base cents and nothing else', () => {
  /**
   * A CHF 300 flat and a EUR 100 dinner at 0.9412, three ways each — the
   * worked example from the issue, reconciled by hand:
   *
   *   flat    30000 base, shares 10000/10000/10000, paid by A
   *   dinner   9412 base, shares  3138/ 3137/ 3137, paid by C
   *
   *   A paid 30000, owes 13138 → +16862
   *   B paid     0, owes 13137 → -13137
   *   C paid  9412, owes 13137 →  -3725
   */
  const flat = entryLines({
    amountCents: 30000,
    fxRate: '1',
    paidByEmail: 'a@e.com',
    shares: [
      { email: 'a@e.com', amountCents: 10000 },
      { email: 'b@e.com', amountCents: 10000 },
      { email: 'c@e.com', amountCents: 10000 }
    ]
  })
  const dinner = entryLines({
    amountCents: 10000,
    fxRate: '0.9412',
    paidByEmail: 'c@e.com',
    shares: [
      { email: 'a@e.com', amountCents: 3334 },
      { email: 'b@e.com', amountCents: 3333 },
      { email: 'c@e.com', amountCents: 3333 }
    ]
  })

  it('reconciles a mixed-currency trip by hand', () => {
    const balances = computeBalances([...flat, ...dinner])
    expect(balances.map(b => [b.email, b.paidCents, b.owedCents, b.netCents])).toEqual([
      ['a@e.com', 30000, 13138, 16862],
      ['c@e.com', 9412, 13137, -3725],
      ['b@e.com', 0, 13137, -13137]
    ])
    expect(balances.reduce((sum, b) => sum + b.netCents, 0)).toBe(0)
  })

  it('reads the signed base amount of a member line and nothing else', () => {
    // The regression, stated as an assertion: the as-spent column must not move
    // a single cent of anybody's balance, whatever nonsense it holds. The
    // category and rounding lines must not either — they are the two kinds of
    // line a balance is not about, and both carry real money.
    const corrupted = [...flat, ...dinner].map(l => ({ ...l, amountCents: 999_999_999 }))
    expect(computeBalances(corrupted)).toEqual(computeBalances([...flat, ...dinner]))
  })

  it('settles the group in base cents, and clears it', () => {
    const plan = suggestSettlements(computeBalances([...flat, ...dinner]))
    expect(plan.map(p => [p.fromEmail, p.toEmail, p.amountCents])).toEqual([
      // Debtors are taken in balance order (the list is sorted by net, descending),
      // so the smaller debt is matched first. Both clear A either way.
      ['c@e.com', 'a@e.com', 3725],
      ['b@e.com', 'a@e.com', 13137]
    ])
    // Paying the plan leaves nobody owing anybody.
    const after = computeBalances([...flat, ...dinner]).map(b => ({ ...b }))
    for (const p of plan) {
      after.find(b => b.email === p.fromEmail)!.netCents += p.amountCents
      after.find(b => b.email === p.toEmail)!.netCents -= p.amountCents
    }
    expect(after.every(b => b.netCents === 0)).toBe(true)
  })

  it('stays consistent when an expense is removed', () => {
    // Deleting the dinner leaves exactly the flat's balances — no residue from
    // a conversion, because nothing was ever accumulated outside base cents.
    expect(computeBalances(flat)).toEqual([
      { name: 'A', email: 'a@e.com', paidCents: 30000, owedCents: 10000, netCents: 20000 },
      { name: 'B', email: 'b@e.com', paidCents: 0, owedCents: 10000, netCents: -10000 },
      { name: 'C', email: 'c@e.com', paidCents: 0, owedCents: 10000, netCents: -10000 }
    ])
  })
})
