/**
 * The scale a percentage or a weight is entered, checked and stored at (#26).
 *
 * It lives in `shared/` because BOTH sides need the same answer and for
 * different reasons: `server/domain/expenses.ts` decides whether a set of
 * percentages sums to 100 and refuses the write when it does not, and
 * `app/components/BudgetCard.vue` shows the running total that lets somebody
 * see `99% of 100%` while they can still fix it. Nuxt auto-imports this
 * directory into both, which is the only way to have one definition instead of
 * two that agree today and drift on the next change — the symptom of that drift
 * being a form that reads `100% of 100%` beside a server that refuses the save.
 *
 * Same argument as `shared/utils/passkey-context.ts`, and the same division of
 * labour: the rule is here, the REFUSAL is the server's. Nothing in this file
 * throws, so it carries no dependency on h3 and can be called from a browser.
 *
 * INTEGERS, NOT FLOATS. A percentage is multiplied and summed, and
 * `0.1 + 0.2 !== 0.3`: `33.33 + 33.33 + 33.34` compared as doubles is not 100,
 * so a split three friends would call obviously fair would be refused. Scaled
 * to `WEIGHT_SCALE` every comparison is exact.
 */

/** `numeric(12, 4)`, the column a weight lands in: four decimal places. */
export const WEIGHT_SCALE = 10_000

/**
 * The shape a percentage or weight may take: at most eight digits before the
 * point and four after — `numeric(12, 4)` again.
 *
 * Four decimals is what makes a percentage split of three people possible at
 * all: `33.3333` three times is not 100, so the honest entry is
 * `33.33/33.33/33.34`. The cap is not cosmetic either. Postgres ROUNDS a fifth
 * decimal into this column silently rather than erroring, so a rate refused
 * here is the only thing keeping the stored intent equal to the entered one.
 * Same reasoning as `FX_RATE_PATTERN` in `server/domain/expenses.ts`.
 */
export const WEIGHT_PATTERN = /^\d{1,8}(?:\.\d{1,4})?$/

/** 100%, at `WEIGHT_SCALE`. What a percentage split has to add up to. */
export const FULL_PERCENT = 100 * WEIGHT_SCALE

/**
 * A typed percentage or weight as an integer at `WEIGHT_SCALE` — `33.33` is
 * `333300`.
 *
 * `null` means "not a number of a shape this can store", which the two callers
 * turn into different things: the server into a 422 naming the limit, the form
 * into a hint under the field. Returning rather than throwing is what lets one
 * function serve both.
 */
export function scaleWeight(value: string | number): number | null {
  const trimmed = `${value}`.trim()
  if (!WEIGHT_PATTERN.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  return Number(whole) * WEIGHT_SCALE + Number(`${frac}0000`.slice(0, 4))
}

/** `333300` back to `'33.33'` — what gets stored, shown, and read back by an edit. */
export function unscaleWeight(scaled: number): string {
  const whole = Math.floor(scaled / WEIGHT_SCALE)
  const frac = `${scaled % WEIGHT_SCALE}`.padStart(4, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}
