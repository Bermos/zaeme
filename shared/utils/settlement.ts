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

/**
 * What a transfer's entry is CALLED. It is a real column on a real row, so it
 * has to say something, and what a reader of an audit log, a `/api/v1` budget
 * or a list of entries wants to know about a payment is who paid whom.
 *
 * DERIVED, NEVER TYPED, AND RE-DERIVED ON EVERY WRITE (#74 review). It was
 * frozen at first, like `paid_by_name` on an expense — and that made it a lie
 * on the one path the change itself endorsed: correcting a mistyped payer or
 * recipient through the ordinary expense PATCH left the title naming the pair
 * it used to be. The card reads the fields and so looked right; `/api/v1`, the
 * audit log and every other consumer of `title` did not. So this is the one
 * place the string is made, both writes call it, and an explicit `title` on a
 * transfer is refused rather than silently discarded.
 *
 * It lives here beside `isSettlement` because it is the same rule: what a
 * transfer IS, and what it is called, are one fact about one shape.
 */
export function settlementTitle(fromName: string, toName: string): string {
  return `${fromName.trim()} → ${toName.trim()}`
}
