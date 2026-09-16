import { describe, expect, it } from 'vitest'
import { resplitFromRecord, splitEvenlyCents, type SplitMode } from '../server/domain/expenses'
import { isPlainEvenSplit } from '../shared/utils/even-split'

/**
 * Re-splitting a CORRECTED expense (#27).
 *
 * `resplitFromRecord` is the whole of "what #26 did and did not record", and it
 * is the one piece of this issue that is decidable from four values — a mode, a
 * new total, an old total, and the member debit lines — so it is pure and it is
 * tested here rather than only over HTTP.
 *
 * TESTS ABOUT VALUES, and about values the wrong answer gets wrong. Every
 * fixture below is lopsided on purpose: a weight split of 1/1/1 is an even
 * split, and a total that divides cleanly is a total on which a dropped
 * remainder is invisible. Where an assertion could pass two ways it is split in
 * two — the sum AND the vector, the message AND the refusal.
 */

interface Recorded { name: string, email: string, amountCents: number, weight: string | null }

const NAMES = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus']

/** The member debits of an entry, as they come off the ledger. */
function recorded(amounts: number[], weights?: Array<string | null>): Recorded[] {
  return amounts.map((amountCents, i) => ({
    name: NAMES[i] ?? `P${i}`,
    email: `${(NAMES[i] ?? `p${i}`).toLowerCase()}@e.com`,
    amountCents,
    weight: weights?.[i] ?? null
  }))
}

function resplit(
  splitMode: SplitMode,
  previousAmountCents: number,
  amountCents: number,
  shares: Recorded[]
) {
  return resplitFromRecord({ splitMode, amountCents, previousAmountCents, shares })
}

const cents = (shares: Array<{ amountCents: number }>) => shares.map(s => s.amountCents)
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

describe('an even split re-splits evenly', () => {
  it('is the issue\'s own case: four ways, 100.00 to 120.00, four shares of 30', () => {
    const out = resplit('even', 10000, 12000, recorded([2500, 2500, 2500, 2500]))
    // Not four of 25.00 and an orphaned 20.00, which is what keeping the old
    // shares and stretching the total would produce.
    expect(cents(out)).toEqual([3000, 3000, 3000, 3000])
    expect(sum(cents(out))).toBe(12000)
  })

  it('hands the remainder out a cent at a time, from the front, at the new total', () => {
    // 100.00 across seven is 14.29 four times then 14.28 three times; 101.00 is
    // 14.43 six times then 14.42. The two vectors differ in WHERE the leftover
    // lands as well as how much, so an implementation that kept the old shape
    // and scaled it fails on both counts.
    const before = splitEvenlyCents(10000, 7)
    expect(before).toEqual([1429, 1429, 1429, 1429, 1428, 1428, 1428])
    const out = resplit('even', 10000, 10100, recorded(before))
    expect(cents(out)).toEqual([1443, 1443, 1443, 1443, 1443, 1443, 1442])
    expect(sum(cents(out))).toBe(10100)
  })

  it('carries no weight onto shares that never had one', () => {
    const out = resplit('even', 10000, 12000, recorded([2500, 2500, 2500, 2500]))
    expect(out.map(s => s.weight)).toEqual([null, null, null, null])
  })

  it('keeps everybody, and keeps them in the order they were written', () => {
    const out = resplit('even', 9000, 6000, recorded([3000, 3000, 3000]))
    expect(out.map(s => s.email)).toEqual(['ana@e.com', 'ben@e.com', 'cy@e.com'])
  })

  it('refuses a new total when somebody was pinned by hand', () => {
    // Ana at 40.00 of 100.00, the other two splitting the remaining 60.00. The
    // shares say so — they are not what `splitEvenlyCents` produces — and which
    // person was pinned is recorded NOWHERE (#26), so there is nothing to
    // re-split from.
    expect(() => resplit('even', 10000, 12000, recorded([4000, 3000, 3000])))
      .toThrow(/some amounts fixed by hand/)
  })

  it('...as a 422, because it is the caller who can fix it', () => {
    expect(() => resplit('even', 10000, 12000, recorded([4000, 3000, 3000])))
      .toThrow(expect.objectContaining({ statusCode: 422 }))
  })

  it('treats somebody pinned at exactly their even share as the even split it is', () => {
    // The consequence of deciding this from the shares rather than from a flag,
    // and it is the right answer: an entry indistinguishable from a plain even
    // split gets what a plain even split gets. 100.00 across three is
    // 33.34/33.33/33.33 whether Ana was pinned at 33.34 or not.
    expect(splitEvenlyCents(10000, 3)).toEqual([3334, 3333, 3333])
    const out = resplit('even', 10000, 9000, recorded([3334, 3333, 3333]))
    expect(cents(out)).toEqual([3000, 3000, 3000])
  })

  it('refuses a pinned split even when it sums to the old total exactly', () => {
    // Summing correctly is not the question — every recorded entry sums
    // correctly. The question is whether the SHAPE is the even one.
    const shares = recorded([5000, 2500, 2500])
    expect(sum(cents(shares))).toBe(10000)
    expect(() => resplit('even', 10000, 20000, shares)).toThrow(/fixed by hand/)
  })
})

describe('a weight split keeps its weights', () => {
  it('re-apportions at the recorded weights, remainder to the largest fractions', () => {
    // 3/2/1 of 100.01 is 50.00 / 33.34 / 16.67 — the two leftover cents land on
    // the SMALLEST two shares, which is the opposite of what an even split does
    // and the opposite of handing them to whoever is first.
    const out = resplit('weight', 8840, 10001, recorded([4420, 2947, 1473], ['3', '2', '1']))
    expect(cents(out)).toEqual([5000, 3334, 1667])
    expect(sum(cents(out))).toBe(10001)
  })

  it('...and hands the weights back, so the next edit can re-split again', () => {
    const out = resplit('weight', 8840, 10001, recorded([4420, 2947, 1473], ['3', '2', '1']))
    expect(out.map(s => s.weight)).toEqual(['3', '2', '1'])
    const again = resplit('weight', 10001, 6000, out.map(s => ({ ...s })))
    expect(cents(again)).toEqual([3000, 2000, 1000])
  })

  it('keeps a person weighted out of the expense at zero', () => {
    const out = resplit('weight', 9000, 12000, recorded([6000, 3000, 0], ['2', '1', '0']))
    expect(cents(out)).toEqual([8000, 4000, 0])
  })

  it('refuses a row that claims the mode and carries no numbers', () => {
    expect(() => resplit('weight', 9000, 12000, recorded([6000, 3000], ['2', null])))
      .toThrow(/does not carry the numbers/)
  })
})

describe('a percentage split re-applies its percentages', () => {
  it('sums to the new total exactly on a total that does not divide', () => {
    // 33.33 / 33.33 / 33.34 of 87.77, worked out by hand in exact integers:
    // 33.33% is 2925.3741, 33.34% is 2926.2518, so the floors are 2925/2925/2926
    // and one cent is left over. It goes to the LARGEST FRACTION, which is
    // .3741 — one of the two smaller percentages — and ties break by position,
    // so the first person gets it and the person with the biggest percentage
    // does not. "Give the leftover to whoever has the most" is the plausible
    // wrong answer this fixture exists to catch.
    const out = resplit('percentage', 10000, 8777, recorded([3333, 3333, 3334], ['33.33', '33.33', '33.34']))
    expect(cents(out)).toEqual([2926, 2925, 2926])
    expect(sum(cents(out))).toBe(8777)
  })

  it('keeps a lopsided split lopsided', () => {
    const out = resplit('percentage', 10000, 4444, recorded([7000, 2000, 1000], ['70', '20', '10']))
    expect(cents(out)).toEqual([3111, 889, 444])
    expect(sum(cents(out))).toBe(4444)
  })

  it('...and the percentages come back with them', () => {
    const out = resplit('percentage', 10000, 4444, recorded([7000, 2000, 1000], ['70', '20', '10']))
    expect(out.map(s => s.weight)).toEqual(['70', '20', '10'])
  })
})

describe('an exact split is not re-derivable from a new total', () => {
  it('refuses, and says what to send instead', () => {
    expect(() => resplit('exact', 10000, 12000, recorded([6000, 3000, 1000])))
      .toThrow(/split by exact amounts/)
  })

  it('...rather than quietly apportioning the amounts somebody chose', () => {
    // The wrong answer is plausible and is exactly what must not happen: 60/30/10
    // scaled to 120.00 is 72/36/12, a proportional split nobody asked for from
    // amounts that meant "Ana's room, Ben's single, Cy's coffee".
    let apportioned = false
    try {
      resplit('exact', 10000, 12000, recorded([6000, 3000, 1000]))
      apportioned = true
    } catch { /* the refusal is the assertion below */ }
    expect(apportioned).toBe(false)
  })
})

describe('a total that did not move needs no re-split at all', () => {
  const MODES: SplitMode[] = ['even', 'exact', 'percentage', 'weight']

  it('hands every mode back verbatim, weights included', () => {
    for (const mode of MODES) {
      const shares = recorded([6000, 3000, 1000], mode === 'even' || mode === 'exact'
        ? [null, null, null]
        : ['60', '30', '10'])
      const out = resplit(mode, 10000, 10000, shares)
      expect(cents(out), mode).toEqual([6000, 3000, 1000])
      expect(out.map(s => s.weight), mode).toEqual(shares.map(s => s.weight))
    }
  })

  it('is what lets a MIXED even split have its title or payer corrected', () => {
    // The case that cannot be re-split is only refused when the total moves. A
    // mixed `even` expense whose amount is untouched keeps its shares, so
    // nobody is asked to retype a split for a number that did not change.
    const out = resplit('even', 10000, 10000, recorded([4000, 3000, 3000]))
    expect(cents(out)).toEqual([4000, 3000, 3000])
  })
})

describe('whatever it returns, the shares sum to the new total exactly', () => {
  it('sweeps lopsided weights across totals that do not divide', () => {
    const WEIGHTS = [['3', '2', '1'], ['7', '1', '1', '1'], ['1', '0', '2.5'], ['33.33', '33.33', '33.34']]
    const TOTALS = [1, 7, 99, 101, 1234, 10001, 87_654_321]
    for (const weights of WEIGHTS) {
      // Any starting shares will do: the weights are what a re-split reads.
      const before = splitEvenlyCents(9000, weights.length)
      for (const total of TOTALS) {
        const out = resplit('weight', 9000, total, recorded(before, weights))
        expect(sum(cents(out)), `${weights.join('/')} of ${total}`).toBe(total)
        expect(out.every(s => s.amountCents >= 0)).toBe(true)
      }
    }
  })

  it('sweeps even splits across sizes and totals', () => {
    for (let n = 1; n <= 12; n++) {
      for (const total of [1, 7, 99, 101, 1234, 10001]) {
        const before = splitEvenlyCents(9000, n)
        const out = resplit('even', 9000, total, recorded(before))
        expect(out).toHaveLength(n)
        expect(sum(cents(out)), `${n} ways of ${total}`).toBe(total)
      }
    }
  })
})

describe('an entry with nobody on it', () => {
  it('is refused rather than re-split into nothing', () => {
    expect(() => resplit('even', 10000, 12000, [])).toThrow(/nobody to split between/)
  })
})

describe('isPlainEvenSplit: the rule the server and the form both ask', () => {
  it('says yes to what splitEvenlyCents produces, at every size', () => {
    for (let n = 1; n <= 9; n++) {
      for (const total of [1, 7, 99, 100, 10000, 10001]) {
        expect(isPlainEvenSplit(splitEvenlyCents(total, n), total), `${n} of ${total}`).toBe(true)
      }
    }
  })

  it('says no to a split with an amount pinned by hand', () => {
    expect(isPlainEvenSplit([4000, 3000, 3000], 10000)).toBe(false)
    expect(isPlainEvenSplit([5000, 2500, 2500], 10000)).toBe(false)
  })

  it('IS ORDER-SENSITIVE, which is the conservative reading', () => {
    // The same three amounts, in the order an even split produces them and in
    // the order a split with Ben pinned at 33.34 produces them. Comparing sorted
    // values would call the second one plain and move a cent off Ben on the next
    // edit, so the vector is compared in place.
    expect(isPlainEvenSplit([3334, 3333, 3333], 10000)).toBe(true)
    expect(isPlainEvenSplit([3333, 3334, 3333], 10000)).toBe(false)
  })

  it('says no to a split that does not add up to the total at all', () => {
    expect(isPlainEvenSplit([3333, 3333, 3333], 10000)).toBe(false)
  })

  it('says no to nobody', () => {
    expect(isPlainEvenSplit([], 10000)).toBe(false)
  })

  it('is the predicate resplitFromRecord actually branches on', () => {
    // The two halves agreeing is the whole point of the rule being shared: the
    // form asks this to decide whether to hand the amounts back, and the server
    // asks it to decide whether to refuse. A fixture it calls plain re-splits.
    expect(isPlainEvenSplit([2500, 2500, 2500, 2500], 10000)).toBe(true)
    expect(cents(resplit('even', 10000, 12000, recorded([2500, 2500, 2500, 2500]))))
      .toEqual([3000, 3000, 3000, 3000])
    // ...and one it calls pinned is refused, rather than re-split behind anybody's back.
    expect(isPlainEvenSplit([4000, 3000, 3000], 10000)).toBe(false)
    expect(() => resplit('even', 10000, 12000, recorded([4000, 3000, 3000]))).toThrow(/fixed by hand/)
  })
})
