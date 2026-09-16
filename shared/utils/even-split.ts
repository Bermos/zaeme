/**
 * Splitting a total evenly, and the one question an EDIT has to ask of a split
 * that was already recorded (#27).
 *
 * It lives in `shared/` for the reason `split-weight.ts` and `conversion.ts` do:
 * BOTH sides need the same answer, and for different reasons. The server refuses
 * to re-split an `even` expense whose amounts were pinned by hand, because #26
 * records nothing about WHICH participants were pinned; the form has to reach
 * the same conclusion one step earlier, so it can hand the recorded amounts back
 * to be corrected instead of letting somebody hit save and decode a refusal.
 *
 * A rule written down twice is a rule that agrees today and drifts on the next
 * change, and the drift here would be the worst kind: one side re-splitting an
 * expense the other side says cannot be re-split moves money between friends.
 * Nothing in this file throws, so it carries no h3 dependency and runs in a
 * browser.
 */

/**
 * Split `totalCents` evenly across `count` participants, distributing the
 * remainder one cent at a time from the front so the shares always sum to the
 * total exactly.
 */
export function splitEvenlyCents(totalCents: number, count: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(totalCents / count)
  const remainder = totalCents - base * count
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
}

/**
 * Whether these recorded amounts are what a PLAIN even split of `totalCents`
 * produces — which is the only way to tell, after the fact, that nobody was
 * pinned by hand.
 *
 * IN ORDER, not as a multiset, and that is the conservative choice. Three people
 * splitting 100.00 evenly get 33.34/33.33/33.33; the same three with Ben pinned
 * at 33.34 get 33.33/33.34/33.33, which holds the same amounts in a different
 * order and is NOT a plain even split. Comparing sorted values would call it one
 * and move a cent off Ben on the next edit.
 *
 * Somebody pinned at exactly their even share is indistinguishable from nobody
 * pinned at all, and rightly gets the same answer: it is the same entry.
 */
export function isPlainEvenSplit(amountsInOrder: number[], totalCents: number): boolean {
  const evenly = splitEvenlyCents(totalCents, amountsInOrder.length)
  return amountsInOrder.length > 0 && amountsInOrder.every((cents, i) => cents === evenly[i])
}
