/**
 * "Was this entry converted?" — one rule, because the server and the screen
 * both have to answer it and they were answering it differently (#59 review).
 *
 * THE WRONG ANSWER, which both sides shipped: `currency !== baseCurrency`. It
 * reads like the definition and it is false for exactly the rows that matter
 * most. A payer who states what their bank actually took keeps that figure
 * through a change of the trip's currency, so a trip that moves to the currency
 * the receipt is in leaves the row saying
 *
 *     currency EUR, baseCurrency EUR, amountCents 24525, amountBaseCents 25425
 *
 * — the two codes equal, the two amounts nine francs apart, and every balance
 * on the trip built from the second one. Under the wrong rule the budget called
 * itself exact and the card printed "Ana paid €245.25" while owing her €254.25,
 * with nothing on screen to explain the gap and nothing to click.
 *
 * THE RIGHT ANSWER IS THE RATE. `fxRate` is 1 when, and only when, nothing was
 * applied to the receipt to get the settled figure — which is the question
 * being asked. It is also the only one of the three fields that survives every
 * path: a recompute rewrites both currency codes and both amounts, and leaves
 * the rate saying what happened.
 *
 * It lives in `shared/` for the reason `split-weight.ts` does: Nuxt auto-imports
 * this directory into the app AND the server, and a rule written down twice is
 * a rule that agrees today and drifts on the next change. Nothing here throws,
 * so it carries no h3 dependency and runs in a browser.
 */

/**
 * Whether a rate did anything — `true` for any rate other than one.
 *
 * It trims its own input rather than trusting the caller to. A `numeric(20, 10)`
 * column comes back from Postgres PADDED TO ITS SCALE (`'1.0000000000'`), the
 * budget read trims it on the way out, and a caller reading the column directly
 * does not; a predicate that is right on one of those and wrong on the other is
 * worse than no predicate.
 */
export function rateApplied(fxRate: string | null | undefined): boolean {
  if (fxRate === null || fxRate === undefined) return false
  const trimmed = fxRate.trim()
  const bare = trimmed.includes('.') ? trimmed.replace(/0+$/, '').replace(/\.$/, '') : trimmed
  return bare !== '' && bare !== '1'
}

/** The same question about a whole entry, which is the shape both callers hold. */
export function wasConverted(entry: { fxRate: string | null | undefined }): boolean {
  return rateApplied(entry.fxRate)
}
