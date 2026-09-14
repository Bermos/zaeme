import { describe, expect, it } from 'vitest'
import {
  apportionCents,
  convertCents,
  resolveShares,
  type ExpenseParticipantInput,
  type SplitMode
} from '../server/domain/expenses'
import { FULL_PERCENT, scaleWeight, unscaleWeight, WEIGHT_SCALE } from '../shared/utils/split-weight'

/**
 * Splitting an expense by percentage or by weight (#26).
 *
 * These are tests about VALUES. A test that greps `resolveShares` for the word
 * "weight" survives every semantic mutation of it — two pull requests this week
 * shipped checks that stayed green with the logic they guarded reversed — so
 * every assertion below EXECUTES a split and pins the cents that come out.
 *
 * And the fixtures are chosen so the wrong answer is visibly different from the
 * right one: an even split of 100.00 across 4 is 25/25/25/25, which is also
 * what a weighted split of 1/1/1/1 gives, so it proves nothing about weights.
 * Every weighted fixture here is lopsided, and every percentage fixture is a
 * percentage no even split would produce.
 */

const PEOPLE = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus']

function people(n: number, weights?: Array<string | number>): ExpenseParticipantInput[] {
  return Array.from({ length: n }, (_, i) => ({
    name: PEOPLE[i] ?? `P${i}`,
    email: `${(PEOPLE[i] ?? `p${i}`).toLowerCase()}@e.com`,
    ...(weights ? { weight: weights[i]! } : {})
  }))
}

const cents = (shares: Array<{ amountCents: number }>) => shares.map(s => s.amountCents)
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

describe('resolveShares: even', () => {
  it('is what an omitted mode does, and what it has always done', () => {
    const list = people(3)
    expect(resolveShares(10000, list)).toEqual(resolveShares(10000, list, 'even'))
    expect(cents(resolveShares(10000, list))).toEqual([3334, 3333, 3333])
  })

  it('still honours an explicit amount and splits the remainder evenly', () => {
    const shares = resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', amountCents: 4000 },
      { name: 'Ben', email: 'ben@e.com' },
      { name: 'Cy', email: 'cy@e.com' }
    ])
    expect(cents(shares)).toEqual([4000, 3000, 3000])
  })

  it('records no weight, because nobody entered one', () => {
    expect(resolveShares(10000, people(2)).every(s => s.weight === null)).toBe(true)
  })

  it('refuses a percentage or a weight, rather than ignoring it', () => {
    // Discarding input silently is how a split lands on the wrong people while
    // the screen shows what was typed.
    expect(() => resolveShares(10000, people(2, [60, 40]))).toThrow(/percentage or weight split/)
  })
})

describe('resolveShares: exact', () => {
  it('takes the amounts as given', () => {
    const shares = resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', amountCents: 6000 },
      { name: 'Ben', email: 'ben@e.com', amountCents: 3000 },
      { name: 'Cy', email: 'cy@e.com', amountCents: 1000 }
    ], 'exact')
    expect(cents(shares)).toEqual([6000, 3000, 1000])
    expect(shares.every(s => s.weight === null)).toBe(true)
  })

  it('refuses amounts that do not add up, where `even` would have absorbed them', () => {
    const short: ExpenseParticipantInput[] = [
      { name: 'Ana', email: 'ana@e.com', amountCents: 6000 },
      { name: 'Ben', email: 'ben@e.com', amountCents: 3000 }
    ]
    expect(() => resolveShares(10000, short, 'exact')).toThrow(/add up to the expense total/)
    // The same input under `even`: the 1000 that is missing is not an error
    // there, because there is nobody flexible to give it to either. This is the
    // one place the two modes could be confused, so pin both.
    expect(() => resolveShares(10000, short, 'even')).toThrow(/add up to the expense total/)
  })

  it('refuses a participant with no amount at all', () => {
    expect(() => resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', amountCents: 10000 },
      { name: 'Ben', email: 'ben@e.com' }
    ], 'exact')).toThrow(/needs an amount for everybody/)
  })

  it('allows a zero amount — "on the list, owes nothing this time"', () => {
    expect(cents(resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', amountCents: 10000 },
      { name: 'Ben', email: 'ben@e.com', amountCents: 0 }
    ], 'exact'))).toEqual([10000, 0])
  })
})

describe('resolveShares: percentage', () => {
  it('divides by the percentages given, not evenly', () => {
    // 50/30/20 of CHF 100.00. An even split is 3334/3333/3333, so nothing here
    // could be produced by the default.
    expect(cents(resolveShares(10000, people(3, [50, 30, 20]), 'percentage')))
      .toEqual([5000, 3000, 2000])
  })

  it('handles the thirds people actually type', () => {
    // 33.33 + 33.33 + 33.34 = 100 exactly at the column's scale, which is the
    // whole reason percentages are stored with four decimals.
    const shares = cents(resolveShares(10000, people(3, ['33.33', '33.33', '33.34']), 'percentage'))
    expect(shares).toEqual([3333, 3333, 3334])
    expect(sum(shares)).toBe(10000)
  })

  it('says WHICH sum it got when the percentages are wrong', () => {
    expect(() => resolveShares(10000, people(3, [33, 33, 33]), 'percentage'))
      .toThrow('Those percentages add up to 99%, not 100%')
    expect(() => resolveShares(10000, people(3, [34, 34, 33]), 'percentage'))
      .toThrow('Those percentages add up to 101%, not 100%')
    expect(() => resolveShares(10000, people(2, ['50.005', '50']), 'percentage'))
      .toThrow('Those percentages add up to 100.005%, not 100%')
  })

  it('lets one person carry the whole thing, and the rest carry none', () => {
    expect(cents(resolveShares(9999, people(3, [100, 0, 0]), 'percentage')))
      .toEqual([9999, 0, 0])
  })

  it('distributes an indivisible remainder a cent at a time', () => {
    // 100.01 split 33.33/33.33/33.34 does not divide: the floors are
    // 3333/3333/3334 and one cent is left over. It goes to the LARGEST
    // fractional part — the 33.34 — and not to whoever happens to be first or
    // last in the list.
    const shares = cents(resolveShares(10001, people(3, ['33.33', '33.33', '33.34']), 'percentage'))
    expect(sum(shares)).toBe(10001)
    expect(shares).toEqual([3333, 3333, 3335])
  })

  it('refuses a per-person amount beside a percentage', () => {
    expect(() => resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', weight: 50, amountCents: 5000 },
      { name: 'Ben', email: 'ben@e.com', weight: 50 }
    ], 'percentage')).toThrow(/not per-person amounts/)
  })

  it('refuses a missing percentage rather than reading it as zero', () => {
    expect(() => resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', weight: 100 },
      { name: 'Ben', email: 'ben@e.com' }
    ], 'percentage')).toThrow('Ben has no percentage — give everybody one, or 0 to leave them out of this expense')
  })

  it('refuses a percentage with more precision than is stored', () => {
    expect(() => resolveShares(10000, people(2, ['50.00001', '49.99999']), 'percentage'))
      .toThrow(/at most 4 decimal places/)
    expect(() => resolveShares(10000, people(2, ['-50', '150']), 'percentage')).toThrow()
  })
})

describe('resolveShares: weight', () => {
  it('"Ana counts double"', () => {
    // 2/1/1 of CHF 100.00 is 50/25/25 — and an even split would be
    // 3334/3333/3333, so this assertion fails the moment the mode is ignored.
    const shares = resolveShares(10000, people(3, [2, 1, 1]), 'weight')
    expect(cents(shares)).toEqual([5000, 2500, 2500])
    expect(shares.map(s => s.weight)).toEqual(['2', '1', '1'])
  })

  it('treats a weight of 0 as "not in this one"', () => {
    // Four people, the last one out. An even split across all four is
    // 2500/2500/2500/2500, so only the trailing 0 tells the two modes apart —
    // which is exactly why it is asserted rather than the head of the list.
    expect(cents(resolveShares(10000, people(4, [1, 1, 1, 0]), 'weight')))
      .toEqual([3334, 3333, 3333, 0])
  })

  it('refuses a split where everybody is out', () => {
    expect(() => resolveShares(10000, people(3, [0, 0, 0]), 'weight'))
      .toThrow(/at least one person needs a weight above zero/i)
  })

  it('accepts a fractional weight and keeps it as entered', () => {
    const shares = resolveShares(10000, people(3, ['1.5', '1', '1']), 'weight')
    expect(cents(shares)).toEqual([4286, 2857, 2857])
    expect(sum(cents(shares))).toBe(10000)
    expect(shares.map(s => s.weight)).toEqual(['1.5', '1', '1'])
  })

  it('does not care what the weights sum to', () => {
    // 6/3/1 and 60/30/10 are the same split; neither is a percentage.
    expect(cents(resolveShares(10000, people(3, [6, 3, 1]), 'weight')))
      .toEqual(cents(resolveShares(10000, people(3, [60, 30, 10]), 'weight')))
    expect(cents(resolveShares(10000, people(3, [6, 3, 1]), 'weight')))
      .toEqual([6000, 3000, 1000])
  })

  it('refuses a missing weight rather than reading it as zero', () => {
    expect(() => resolveShares(10000, [
      { name: 'Ana', email: 'ana@e.com', weight: 2 },
      { name: 'Ben', email: 'ben@e.com' }
    ], 'weight')).toThrow('Ben has no weight — give everybody one, or 0 to leave them out of this expense')
  })
})

describe('every mode, at the boundaries', () => {
  const MODES: SplitMode[] = ['even', 'exact', 'percentage', 'weight']

  it('splits across one person, whichever mode was asked for', () => {
    expect(cents(resolveShares(10000, people(1), 'even'))).toEqual([10000])
    expect(cents(resolveShares(10000, [{ name: 'Ana', email: 'ana@e.com', amountCents: 10000 }], 'exact'))).toEqual([10000])
    expect(cents(resolveShares(10000, people(1, [100]), 'percentage'))).toEqual([10000])
    expect(cents(resolveShares(10000, people(1, [7]), 'weight'))).toEqual([10000])
  })

  it('refuses an empty participant list in every mode', () => {
    for (const mode of MODES) {
      expect(() => resolveShares(10000, [], mode)).toThrow(/at least one participant/)
    }
  })

  it('counts one person once, however many times they are listed', () => {
    const twice: ExpenseParticipantInput[] = [
      { name: 'Ana', email: 'ana@e.com', weight: 3 },
      { name: 'Ana again', email: 'ANA@e.com', weight: 99 },
      { name: 'Ben', email: 'ben@e.com', weight: 1 }
    ]
    const shares = resolveShares(10000, twice, 'weight')
    expect(shares.map(s => s.email)).toEqual(['ana@e.com', 'ben@e.com'])
    expect(cents(shares)).toEqual([7500, 2500])
  })

  it('sums to the total EXACTLY for 7 people and 100.00 — the issue\'s own case', () => {
    // 7 into 10000 leaves 4 cents over in every mode that has to divide.
    expect(cents(resolveShares(10000, people(7), 'even')))
      .toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428])
    const byWeight = cents(resolveShares(10000, people(7, [1, 1, 1, 1, 1, 1, 1]), 'weight'))
    expect(sum(byWeight)).toBe(10000)
    const lopsided = cents(resolveShares(10000, people(7, [3, 2, 1, 1, 1, 1, 1]), 'weight'))
    expect(lopsided).toEqual([3000, 2000, 1000, 1000, 1000, 1000, 1000])
    const pct = cents(resolveShares(10000, people(7, ['14.28', '14.28', '14.29', '14.29', '14.29', '14.29', '14.28']), 'percentage'))
    expect(sum(pct)).toBe(10000)
  })

  it('sums to the total exactly for every split size and every awkward total', () => {
    for (const total of [1, 7, 99, 100, 10_000, 99_999, 123_457]) {
      for (let n = 1; n <= 40; n++) {
        // Lopsided on purpose: equal weights would hide a mode that fell back
        // to an even split.
        const weights = Array.from({ length: n }, (_, i) => (i % 5) + 1)
        const byWeight = cents(resolveShares(total, people(n, weights), 'weight'))
        expect(sum(byWeight)).toBe(total)
        expect(byWeight.every(c => c >= 0)).toBe(true)
        expect(cents(resolveShares(total, people(n), 'even')).reduce((a, b) => a + b, 0)).toBe(total)
      }
    }
  })

  it('never hands a cent to somebody weighted out of the split', () => {
    // The remainder goes to the largest fractional parts, and a zero weight has
    // no fractional part — but "no leftover reaches a zero" is a property of
    // the distribution, not an obvious one, so it is swept rather than argued.
    for (const total of [1, 2, 3, 7, 101, 9999, 100_003]) {
      for (let n = 2; n <= 25; n++) {
        const weights = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 0 : (i % 4) + 1))
        if (weights.every(w => w === 0)) continue
        const shares = cents(resolveShares(total, people(n, weights), 'weight'))
        expect(sum(shares)).toBe(total)
        shares.forEach((c, i) => {
          if (weights[i] === 0) expect(c).toBe(0)
        })
      }
    }
  })
})

describe('a split sums exactly in what was SPENT, at every size and rate', () => {
  /**
   * Every mode resolves to cents that add up to the total exactly — that is the
   * guarantee `resolveShares` gives, and it is the balance check the ledger's
   * as-spent column rests on (#61).
   *
   * `apportionCents` is the machinery, and the two assertions below are about
   * it directly. NOTE that the write path no longer uses it to convert shares
   * into base cents: since #61 each share converts on its own, so what one
   * person owes is explicable without reference to the others, and the cents
   * that leaves over post to the event's `Rounding` account rather than being
   * handed to the largest fractional remainder. `test/expense-ledger.test.ts`
   * is where that half lives.
   */
  it('for six rates, forty split sizes and a dozen totals', () => {
    const rates = ['1', '0.9412', '1.1', '0.836719', '1.0000000001', '123.456789']
    const totals = [1, 3, 7, 100, 999, 10_000, 12_345, 99_999, 123_457, 1_000_000, 2_222_222, 7_654_321]
    for (const rate of rates) {
      for (const total of totals) {
        const converted = convertCents(total, rate)
        for (let n = 1; n <= 40; n++) {
          const weights = Array.from({ length: n }, (_, i) => (i % 7) + 1)
          const spent = cents(resolveShares(total, people(n, weights), 'weight'))
          expect(sum(spent)).toBe(total)
          const base = apportionCents(spent, total, converted)
          expect(sum(base)).toBe(converted)
          expect(base.every(c => c >= 0)).toBe(true)
        }
      }
    }
  })

  it('for a percentage split of a EUR dinner, apportioned as a group', () => {
    // EUR 100.00 at 0.8367 is CHF 83.67. 50/25/25 of the euros is
    // 5000/2500/2500; the francs do not divide the same way, and apportioning
    // as a group is what would make them add up to the converted total. The
    // ledger does NOT do this any more — 4183 is 5000 x 0.8367 rounded DOWN,
    // which is a cent less than that person actually owes — and the difference
    // between these figures and the per-share conversions is exactly the cent
    // that now posts to `Rounding`.
    const spent = cents(resolveShares(10000, people(3, [50, 25, 25]), 'percentage'))
    expect(spent).toEqual([5000, 2500, 2500])
    const converted = convertCents(10000, '0.8367')
    expect(converted).toBe(8367)
    const base = apportionCents(spent, 10000, converted)
    expect(base).toEqual([4183, 2092, 2092])
    expect(sum(base)).toBe(8367)
  })
})

describe('the entered-weight scale, which the form and the server share', () => {
  /**
   * `shared/utils/split-weight.ts` is one definition read from two places: the
   * server refuses a write whose percentages do not sum to 100, and
   * `BudgetCard.vue` shows the running total that lets somebody see `99% of
   * 100%` before they save. It used to be two copies that agreed — which is the
   * state a rule is in immediately before it stops agreeing, the symptom being
   * a form reading `100% of 100%` beside a server that refuses.
   */
  it('scales a typed decimal to an integer, exactly', () => {
    expect(scaleWeight('33.33')).toBe(333_300)
    expect(scaleWeight('2')).toBe(20_000)
    expect(scaleWeight(2)).toBe(20_000)
    expect(scaleWeight('0')).toBe(0)
    expect(scaleWeight(' 1.5 ')).toBe(15_000)
    expect(scaleWeight('0.0001')).toBe(1)
  })

  it('makes the thirds people type add up to exactly 100', () => {
    // The whole reason this is integers: as doubles, 33.33 + 33.33 + 33.34 is
    // 99.99999999999999 and a split three friends would call fair is refused.
    const thirds = ['33.33', '33.33', '33.34'].map(v => scaleWeight(v)!)
    expect(thirds.reduce((a, b) => a + b, 0)).toBe(FULL_PERCENT)
    expect(FULL_PERCENT).toBe(100 * WEIGHT_SCALE)
  })

  it('refuses what the column could not store as written', () => {
    // Postgres ROUNDS a fifth decimal into `numeric(12,4)` rather than
    // erroring, so this refusal is the only thing keeping the stored intent
    // equal to the entered one.
    expect(scaleWeight('33.33333')).toBeNull()
    expect(scaleWeight('999999999')).toBeNull()
    expect(scaleWeight('-1')).toBeNull()
    expect(scaleWeight('')).toBeNull()
    expect(scaleWeight('abc')).toBeNull()
  })

  it('round-trips back to what was typed', () => {
    for (const entered of ['0', '1', '2', '1.5', '33.33', '14.29', '0.0001', '99.9999']) {
      expect(unscaleWeight(scaleWeight(entered)!)).toBe(entered)
    }
  })

  it('is the same rule the domain enforces', () => {
    // Stated as an execution rather than as a comment: the message the write
    // refuses with names this module's limit, and the split it accepts is the
    // one this module says sums to 100.
    expect(() => resolveShares(10000, people(2, ['50.00001', '49.99999']), 'percentage'))
      .toThrow(/at most 4 decimal places/)
    expect(cents(resolveShares(10000, people(3, ['33.33', '33.33', '33.34']), 'percentage')))
      .toEqual([3333, 3333, 3334])
  })
})
