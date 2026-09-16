import { describe, expect, it } from 'vitest'
import {
  buildEntryLines,
  computeBalances,
  computeTotalCents,
  convertCents,
  deriveRate,
  suggestSettlements,
  type LedgerLine,
  type LedgerLineView
} from '../server/domain/expenses'
import { type EntryLines, recomputeEntry } from '../server/domain/event-currency'

/**
 * Changing what a trip settles in (#59) — the arithmetic, without a database.
 *
 * EVERY EXPECTED FIGURE HERE WAS COMPUTED BY THIS FILE'S AUTHOR, in exact
 * decimal, and is written out as a literal. None of it is re-derived from the
 * function under test, which is the shape that cannot fail (`ci-upgrade-check`
 * shipped one of those once, summing the server's own lines and comparing them
 * to the server's own total).
 *
 * THE FIXTURE IS LOPSIDED ON PURPOSE. 1/1/1/1 across 100.00 is 25/25/25/25
 * under every split mode there is and proves none of them, and three equal
 * shares converted at any rate either all round the same way or all do not. The
 * shares below are 111.11 / 77.77 / 19.13 and the rate has ten decimals,
 * because that is the combination under which converting each debt on its own
 * and converting their sum give DIFFERENT answers — which is the whole subject.
 */

/* The trip's old currency is CHF, the new one EUR, at a rate with ten decimals. */
const RATE = '1.0865432109'

/*
 * Ana paid a EUR 245.25 hotel bill on a CHF trip, split three unequal ways.
 * The as-spent shares are facts and never move:
 */
const RECEIPT_CENTS = 24525
const SPENT_SHARES = [13100, 9170, 2255]

/*
 * What the trip already holds in CHF: Ana said her bank took CHF 208.01, and
 * the three debts were apportioned from it. These are the numbers people have
 * been looking at and possibly settling against.
 */
const OLD_TARGET = 20801
const OLD_SHARES = [11111, 7777, 1913]

/*
 * Converted into EUR at RATE, one number at a time, half up:
 *
 *   208.01 x 1.0865432109 = 226.0140...  ->  22601
 *   111.11 x 1.0865432109 = 120.7269...  ->  12073
 *    77.77 x 1.0865432109 =  84.4996...  ->   8450
 *    19.13 x 1.0865432109 =  20.7855...  ->   2079
 *                                   sum  =  22602
 *
 * The three debts come to one cent MORE than the bill they came out of. Nobody
 * is wrong; converting a sum and converting its parts are different operations.
 */
const NEW_TARGET = 22601
const NEW_SHARES = [12073, 8450, 2079]
const RESIDUAL = 1

const ACCOUNTS = { ana: 'acc-ana', ben: 'acc-ben', cleo: 'acc-cleo', food: 'acc-food', rounding: 'acc-rounding' }

function grouped(): EntryLines {
  return {
    payer: { accountId: ACCOUNTS.ana, amountCents: -RECEIPT_CENTS, amountBaseCents: -OLD_TARGET },
    categoryAccountId: ACCOUNTS.food,
    shares: [
      { accountId: ACCOUNTS.ana, amountCents: SPENT_SHARES[0]!, amountBaseCents: OLD_SHARES[0]!, weight: null },
      { accountId: ACCOUNTS.ben, amountCents: SPENT_SHARES[1]!, amountBaseCents: OLD_SHARES[1]!, weight: null },
      { accountId: ACCOUNTS.cleo, amountCents: SPENT_SHARES[2]!, amountBaseCents: OLD_SHARES[2]!, weight: null }
    ]
  }
}

/** The same lines a budget read would hand `computeBalances`. */
function asViews(lines: LedgerLine[]): LedgerLineView[] {
  const meta: Record<string, { name: string, kind: LedgerLineView['accountKind'], email: string | null }> = {
    [ACCOUNTS.ana]: { name: 'Ana', kind: 'member', email: 'ana@example.com' },
    [ACCOUNTS.ben]: { name: 'Ben', kind: 'member', email: 'ben@example.com' },
    [ACCOUNTS.cleo]: { name: 'Cleo', kind: 'member', email: 'cleo@example.com' },
    [ACCOUNTS.food]: { name: 'Food', kind: 'category', email: null },
    [ACCOUNTS.rounding]: { name: 'Rounding', kind: 'rounding', email: null }
  }
  return lines.map(l => ({
    ...l,
    accountName: meta[l.accountId]!.name,
    accountKind: meta[l.accountId]!.kind,
    accountEmail: meta[l.accountId]!.email
  }))
}

describe('a trip changing currency re-expresses what is already owed', () => {
  it('converts each debt on its own, at the one rate', () => {
    const { lines, amountBaseCents } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    expect(amountBaseCents).toBe(NEW_TARGET)
    const debits = lines.filter(l => l.amountCents > 0 && l.accountId !== ACCOUNTS.food)
    expect(debits.map(l => l.amountBaseCents)).toEqual(NEW_SHARES)
    // Re-apportioning the new total across the same as-spent shares gives
    // 12072/8451/2078 instead — two of the three people moved by a cent from
    // the debt they already had, in opposite directions, for no reason they
    // could be told. That is the answer this deliberately does not produce, and
    // it is pinned below as the value the write path really does give.
    expect(debits.map(l => l.amountBaseCents)).not.toEqual([12072, 8451, 2078])
  })

  it('books the cent it leaves over to Rounding, not to a person', () => {
    const { lines } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    const rounding = lines.filter(l => l.accountId === ACCOUNTS.rounding)
    expect(rounding).toHaveLength(1)
    expect(rounding[0]!.amountBaseCents).toBe(RESIDUAL)
    // It is a conversion artefact, so it exists in the settled column only:
    // nothing extra was handed over at the till.
    expect(rounding[0]!.amountCents).toBe(0)
  })

  it('still sums to zero in both columns, which is the invariant', () => {
    const { lines } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    expect(lines.reduce((n, l) => n + l.amountCents, 0)).toBe(0)
    expect(lines.reduce((n, l) => n + l.amountBaseCents, 0)).toBe(0)
  })

  it('credits the payer what the group owes them, so the members still net out', () => {
    const { lines } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    const credit = lines.find(l => l.accountId === ACCOUNTS.ana && l.amountBaseCents < 0)!
    // 22602, the sum of the three debts — NOT 22601, the converted bill. The
    // difference is exactly why the residual cannot sit between these two.
    expect(credit.amountBaseCents).toBe(-(NEW_SHARES[0]! + NEW_SHARES[1]! + NEW_SHARES[2]!))
    expect(credit.amountBaseCents).toBe(-22602)
  })

  it('leaves the balances summing to zero and the plan closing exactly', () => {
    const { lines } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    const balances = computeBalances(asViews(lines))
    expect(balances.reduce((n, b) => n + b.netCents, 0)).toBe(0)
    // Ana fronted 226.02 of debt and owes 120.73 of it: 105.29 back.
    expect(balances.find(b => b.email === 'ana@example.com')!.netCents).toBe(10529)
    const plan = suggestSettlements(balances)
    expect(plan.reduce((n, p) => n + p.amountCents, 0)).toBe(10529)
    expect(plan.map(p => [p.fromEmail, p.amountCents])).toEqual([
      ['cleo@example.com', 2079],
      ['ben@example.com', 8450]
    ])
  })

  it('keeps the residual out of the trip total, which is what the bill cost', () => {
    const { lines } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })
    expect(computeTotalCents(asViews(lines))).toBe(NEW_TARGET)
  })

  it('converts at 1 when the trip moves to the currency the receipt is in', () => {
    // The whole point of the special case: EUR 245.25 spent, a trip that now
    // settles in EUR, and the shares come back as the EXACT figures on the
    // receipt rather than anything rounded through CHF and back.
    const { lines, amountBaseCents } = recomputeEntry({
      grouped: grouped(),
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: true,
      rate: RATE
    })
    expect(amountBaseCents).toBe(RECEIPT_CENTS)
    expect(lines.filter(l => l.amountCents > 0 && l.accountId !== ACCOUNTS.food).map(l => l.amountBaseCents))
      .toEqual(SPENT_SHARES)
    expect(lines.some(l => l.accountId === ACCOUNTS.rounding)).toBe(false)
    expect(lines.reduce((n, l) => n + l.amountBaseCents, 0)).toBe(0)
  })

  it('refuses an entry with no payer line rather than writing a wrong one', () => {
    const g = grouped()
    g.payer = null
    expect(() => recomputeEntry({
      grouped: g,
      amountCents: RECEIPT_CENTS,
      amountBaseCents: OLD_TARGET,
      roundingAccountId: ACCOUNTS.rounding,
      identity: false,
      rate: RATE
    })).toThrow(/no payer line/)
  })
})

describe('the write path is untouched by any of this', () => {
  it('still apportions as a group and still books nothing to Rounding', () => {
    // The same lopsided split, recorded fresh rather than re-expressed: the
    // shares are derived from the total here, so converting them separately
    // would INVENT a cent of liability instead of discovering one (#61).
    const lines = buildEntryLines({
      amountCents: RECEIPT_CENTS,
      amountBaseCents: NEW_TARGET,
      payerAccountId: ACCOUNTS.ana,
      categoryAccountId: ACCOUNTS.food,
      roundingAccountId: ACCOUNTS.rounding,
      shares: [
        { accountId: ACCOUNTS.ana, amountCents: SPENT_SHARES[0]!, weight: null },
        { accountId: ACCOUNTS.ben, amountCents: SPENT_SHARES[1]!, weight: null },
        { accountId: ACCOUNTS.cleo, amountCents: SPENT_SHARES[2]!, weight: null }
      ]
    })
    expect(lines.some(l => l.accountId === ACCOUNTS.rounding)).toBe(false)
    const debits = lines.filter(l => l.amountCents > 0 && l.accountId !== ACCOUNTS.food)
    expect(debits.reduce((n, l) => n + l.amountBaseCents, 0)).toBe(NEW_TARGET)
    // 24525 spent, 22601 settled. The proportional shares are 12072.71,
    // 8450.81 and 2078.09; the floors come to 22600, so the one leftover cent
    // goes to the largest remainder — the SECOND person — and the three sum to
    // the total exactly. Note how different that is from the recompute above,
    // which gave 12073/8450/2079: the same three people, the same money, and a
    // different answer depending on whether the debts existed yet.
    expect(debits.map(l => l.amountBaseCents)).toEqual([12072, 8451, 2078])
  })
})

describe('a transfer between two friends is not a cost', () => {
  /*
   * #28's shape, ready rather than written: an entry with member lines only.
   * Nothing mints one through an HTTP route yet, and the structure — not a
   * `kind` flag somebody has to remember to set — is what keeps it out of the
   * trip total and lets it clear a debt.
   */
  const transfer = buildEntryLines({
    amountCents: 30000,
    amountBaseCents: 30000,
    payerAccountId: ACCOUNTS.ben,
    categoryAccountId: null,
    roundingAccountId: ACCOUNTS.rounding,
    shares: [{ accountId: ACCOUNTS.ana, amountCents: 30000, weight: null }]
  })

  it('writes two lines and no category line at all', () => {
    expect(transfer).toHaveLength(2)
    expect(transfer.every(l => l.accountId !== ACCOUNTS.food)).toBe(true)
    expect(transfer.reduce((n, l) => n + l.amountBaseCents, 0)).toBe(0)
  })

  it('is excluded from the trip total by its shape', () => {
    expect(computeTotalCents(asViews(transfer))).toBe(0)
  })

  it('nets the debt it settles to zero', () => {
    // Ben owed Ana 300.00; he transfers it. The two entries together leave both
    // of them on zero and the plan empty, which is what settling up means.
    const debt = buildEntryLines({
      amountCents: 30000,
      amountBaseCents: 30000,
      payerAccountId: ACCOUNTS.ana,
      categoryAccountId: ACCOUNTS.food,
      roundingAccountId: ACCOUNTS.rounding,
      shares: [{ accountId: ACCOUNTS.ben, amountCents: 30000, weight: null }]
    })
    const balances = computeBalances(asViews([...debt, ...transfer]))
    expect(balances.map(b => [b.email, b.netCents])).toEqual([
      ['ana@example.com', 0],
      ['ben@example.com', 0]
    ])
    expect(suggestSettlements(balances)).toEqual([])
    // …and the trip still cost 300.00 once, not twice.
    expect(computeTotalCents(asViews([...debt, ...transfer]))).toBe(30000)
  })
})

describe('the rate behind a figure somebody typed off a statement', () => {
  it('is the effective rate, fee and all', () => {
    // EUR 120.00 that cost CHF 113.47: 1.13470 / 1.2 = 0.9455833333…, which is
    // the mid-market rate plus whatever the bank took. Truncated to the ten
    // decimals the column holds.
    expect(deriveRate(12000, 11347)).toBe('0.9455833333')
  })

  it('is exact where it divides, and trims the padding', () => {
    expect(deriveRate(10000, 9412)).toBe('0.9412')
    expect(deriveRate(5000, 10000)).toBe('2')
  })

  it('rounds half up at the tenth decimal, like every other rate here', () => {
    // 1/3 is 0.333333333333…, so the tenth decimal rounds up to …3333.
    expect(deriveRate(30000, 10000)).toBe('0.3333333333')
  })

  it('refuses a pair that will not fit the column', () => {
    expect(() => deriveRate(1, 2_000_000_000)).toThrow()
    expect(() => deriveRate(0, 100)).toThrow()
  })

  it('does not claim to reproduce the figure it came from', () => {
    // The stated total is the source of truth and the rate is a record of it.
    // On ordinary money the two agree, and this pins THAT rather than a general
    // promise the arithmetic cannot make.
    expect(convertCents(12000, deriveRate(12000, 11347))).toBe(11347)
    expect(convertCents(24525, deriveRate(24525, 22601))).toBe(22601)
  })
})
