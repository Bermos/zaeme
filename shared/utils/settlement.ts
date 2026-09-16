/**
 * "Is this entry a settlement?" — one rule, for the same reason
 * `conversion.ts` holds one (#59 review): the server and the screen both have
 * to answer it, and a rule written down twice agrees today and drifts on the
 * next change.
 *
 * THE ANSWER IS THE SHAPE, NOT A FLAG. #28 was originally specified with a
 * `kind: 'expense' | 'settlement'` column, and #61 designed it out: a
 * settlement is a member-to-member transfer that touches NO category account,
 * so it is structurally not a cost. The trip total is the sum of debits into
 * category accounts, so a transfer is excluded from it without anybody having
 * to remember to set anything — and a flag and a shape cannot disagree about
 * one entry, because there is only the shape.
 *
 * `categoryAccountId` is that shape, projected: `loadBudget` reads it off the
 * entry's positive category line, and an entry with no such line reports
 * `null`. Every other entry in this app has one, because `resolveCategoryAccount`
 * answers `Uncategorised` when nobody picked anything.
 *
 * ABSENT IS NOT NULL, and the asymmetry is deliberate. A payload that does not
 * carry the field at all — an older client's cached response, a projection that
 * dropped it — must read as "not a settlement": the failure mode of the other
 * choice is a whole budget rendering as transfers and vanishing out of the
 * total. So `undefined` is false and only an explicit `null` is true.
 *
 * Nothing here throws, so it carries no h3 dependency and runs in a browser.
 */

/** Whether an entry is a member-to-member transfer rather than a cost (#28). */
export function isSettlement(entry: { categoryAccountId?: string | null }): boolean {
  return entry.categoryAccountId === null
}
