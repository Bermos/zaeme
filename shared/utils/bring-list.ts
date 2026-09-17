/**
 * HOW MUCH OF A BRING-LIST ITEM IS STILL MISSING (#44).
 *
 * `events_contribution.quantity` is free text — "some crisps", "for 8 people" —
 * and `claimed_by_email` was a single nullable column, so an item was claimed by
 * exactly one person or by nobody. The two questions a potluck actually asks
 * were therefore inexpressible: HOW MUCH IS STILL MISSING, and CAN TWO OF US
 * SPLIT THE SALAD. `quantity_needed` and `events_contribution_claim` answer
 * them; this is the arithmetic that turns those rows into "6 bottles needed,
 * 4 claimed, 2 to go".
 *
 * ── WHY IT IS A FUNCTION IN `shared/utils/` AND NOT A LINE IN EACH PLACE ────
 *
 * Because THREE places say it and they must not be able to disagree. The server
 * decides whether an item is done (`listContributions`, and `claimContribution`
 * refuses a claim on an item that already is); `BringList.vue` draws the
 * remainder and caps the number field with it; the host page draws the same
 * sentence. Nuxt auto-imports this into the app and server code takes it by
 * relative path, so all three read one rule and `test/bring-list.test.ts`
 * executes it — which nothing in this repository does for a `.vue` file.
 *
 * ── THE RULE, AND THE CASE THAT BREAKS SILENTLY ─────────────────────────────
 *
 * AN ITEM WITH NO `quantityNeeded` BEHAVES EXACTLY AS IT DID BEFORE THIS ISSUE:
 * it is claimed when somebody has claimed it and unclaimed otherwise, and there
 * is no remainder to show because nobody ever said how much would be enough.
 * That is the acceptance criterion most likely to be lost by accident, because
 * the obvious wrong version — treat a missing need as a need of zero — makes
 * every such item read as DONE the moment it is created, with nobody bringing
 * anything. `remaining` is `null` for it rather than `0`, which is why this
 * returns a discriminated shape instead of a number somebody has to remember is
 * meaningless.
 *
 * OVER-CLAIMING IS ALLOWED AND CLAMPS. Six bottles wanted and ten claimed is a
 * real thing that happens at a party, not an error state, so `remaining` floors
 * at 0 and `done` is `>=` rather than `===`. Nothing here refuses anything; the
 * refusal `claimContribution` makes is a separate decision written there.
 */

/** One person's claim, as much of it as the arithmetic needs. */
export interface ClaimQuantity {
  quantityClaimed: number
}

/** What a bring-list item's claims add up to. */
export interface ContributionTally {
  /** Everything claimed on this item, across every claimer. */
  claimedTotal: number
  /**
   * How much is still wanted — and `null` when nobody stated a need, which is
   * NOT the same as `0` and must never be rendered as "0 to go".
   */
  remaining: number | null
  /**
   * Whether this item is finished. With a stated need, that is "the claims meet
   * it". Without one, it is "somebody claimed it", which is what `claimed` has
   * always meant on this list.
   */
  done: boolean
}

/**
 * The tally for one item. `quantityNeeded` is `null` for the free-text items
 * this list is mostly made of ("some crisps"), and every claim carries a whole
 * number of whatever `unit` says.
 */
export function contributionTally(
  quantityNeeded: number | null | undefined,
  claims: readonly ClaimQuantity[]
): ContributionTally {
  const claimedTotal = claims.reduce((n, c) => n + (c.quantityClaimed || 0), 0)
  // `== null` on purpose: `undefined` from a caller that has not selected the
  // column and `null` from the database are the same statement — nobody said
  // how much. A falsy check would put a stated need of 0 in this branch too,
  // and "we need zero of these" is a different thing to say.
  if (quantityNeeded == null) {
    return { claimedTotal, remaining: null, done: claimedTotal > 0 }
  }
  return {
    claimedTotal,
    remaining: Math.max(0, quantityNeeded - claimedTotal),
    done: claimedTotal >= quantityNeeded
  }
}

/**
 * The sentence a screen puts under the item's title — "6 bottles needed, 4
 * claimed, 2 to go" — or `null` when there is no count to talk about, in which
 * case the item renders exactly as it did before this issue.
 *
 * The unit is optional and the sentence reads without it ("6 needed"), because
 * `unit` is a nullable free-text column and half the things on a bring list are
 * counted in nothing in particular.
 */
export function remainderLine(
  quantityNeeded: number | null | undefined,
  unit: string | null | undefined,
  claims: readonly ClaimQuantity[]
): string | null {
  if (quantityNeeded == null) return null
  const { claimedTotal, remaining } = contributionTally(quantityNeeded, claims)
  const what = unit ? `${quantityNeeded} ${unit}` : `${quantityNeeded}`
  if (remaining === 0) return `${what} needed, all claimed`
  return `${what} needed, ${claimedTotal} claimed, ${remaining} to go`
}
