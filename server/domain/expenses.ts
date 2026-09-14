import { and, asc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { baseCurrencyWithin, instanceBaseCurrency } from './instance-settings'
import { guestUser } from '../database/schema/auth'
import { assertEventOpenToGuests, assertParticipant, assertPlanner, loadEventBySlug, type ParticipantRole } from './permissions'
import { fetchFxRate, isCurrencyCode, normaliseCurrency } from '../utils/fx'

/**
 * The trip budget: expenses someone fronted, split across participants, and
 * the resulting who-owes-whom. Money is integer cents throughout (no float
 * money); shares are materialised at write time so balances are a plain sum.
 * Identity is the same name+email pair RSVPs use.
 *
 * MIXED CURRENCIES (#25). An expense is recorded in the currency it was spent
 * in and converted ONCE, at write time, into the instance base currency
 * (`server/domain/instance-settings.ts`). Both the rate and the converted
 * amount are frozen onto the row, and every balance, settlement and total in
 * this file is computed from `amountBaseCents` alone. `currency` used to be
 * stored, typed and rendered while nothing summed with it — one €120 dinner on
 * a CHF trip was added as 12000 CHF cents, confidently and silently.
 *
 * SPLIT MODES (#26). An expense can be divided evenly, by exact per-person
 * amounts, by percentage, or by weight. All four are resolved to cents by
 * `resolveShares` at write time and stored materialised, so nothing downstream
 * — a balance, a settlement, a total — knows there is more than one mode. What
 * the person meant is kept beside the amounts (`splitMode` on the expense, the
 * entered `weight` on each share) purely so an edit can re-split without them
 * re-typing it; no read ever computes money from either.
 */

export type ExpenseCategory = 'travel' | 'accommodation' | 'food' | 'tickets' | 'other'

/**
 * How a total is divided across the people it is split between (#26).
 *
 * - `even` — what every expense did before this existed, and still the default:
 *   explicit per-person amounts are honoured, and whatever is left of the total
 *   is split evenly across everybody else.
 * - `exact` — every person carries their own amount and the amounts must sum to
 *   the total. The strict form of the above: nothing is inferred, so a typo is
 *   refused instead of quietly landing on whoever had no amount.
 * - `percentage` — each person's `weight` is their percentage, and the
 *   percentages must sum to 100.
 * - `weight` — each person's `weight` is a share count ("Ana counts double" is
 *   2). Any positive total works; a weight of 0 means "not in this one".
 *
 * The mode is a record of INTENT. It is resolved to cents at write time and no
 * read re-derives anything from it.
 */
export type SplitMode = 'even' | 'exact' | 'percentage' | 'weight'

export interface ExpenseParticipantInput {
  name: string
  email: string
  /**
   * This person's share in cents. Optional under `even` (omit it and they take
   * an even slice of the remainder), required under `exact`, and refused under
   * `percentage` and `weight`, where `weight` says what they owe instead.
   */
  amountCents?: number
  /**
   * The percentage (`percentage`) or the share count (`weight`) as ENTERED —
   * `33.33`, or `2` for someone who counts double. Required under those two
   * modes and refused under the other two, where it would be a second source of
   * truth beside an amount.
   */
  weight?: string | number
}

export interface AddExpenseInput {
  title: string
  category?: ExpenseCategory
  /** The total AS SPENT, in `currency`. */
  amountCents: number
  /** What was handed over. Defaults to the instance base currency. */
  currency?: string
  /**
   * The rate from `currency` into the instance base, supplied by hand. Omit it
   * and the rate is fetched once at write time; supply it and NOTHING is
   * fetched, which is both the override and the answer to an instance with no
   * outbound network.
   */
  fxRate?: string | number
  note?: string | null
  paidByName: string
  paidByEmail: string
  /**
   * How to divide the total. Defaults to `even`, which is exactly what every
   * expense did before this field existed — an omitted `splitMode` is not a
   * new behaviour anywhere.
   */
  splitMode?: SplitMode
  /** Who the cost is split across (usually the trip's yes-RSVPs, payer included). */
  participants: ExpenseParticipantInput[]
}

export interface ExpenseView {
  id: string
  title: string
  category: ExpenseCategory
  /** As spent, in `currency`. */
  amountCents: number
  currency: string
  /** As settled: the frozen conversion of `amountCents` into `baseCurrency`. */
  amountBaseCents: number
  baseCurrency: string
  /** The rate this row was converted at, as a decimal string. `'1'` in base. */
  fxRate: string
  /** How the total was divided (#26). A record of intent; nothing re-derives from it. */
  splitMode: SplitMode
  paidByName: string
  paidByEmail: string
  note: string | null
  createdAt: Date
  /**
   * The ACCOUNT that typed it in, which is not always the person who paid —
   * recording on a friend's behalf is the convenience that makes the account
   * gate bearable (#48). The screen shows both; hiding the recorder would
   * throw away the accountability the account was required for.
   */
  addedByName: string | null
  addedByEmail: string | null
  shares: Array<{
    name: string
    email: string
    amountCents: number
    amountBaseCents: number
    /** The percentage or share count entered for this person, or null. */
    weight: string | null
  }>
}

/**
 * Per-person standing, in BASE cents throughout. The field names carry no
 * `base` because there has never been a balance in anything else and Enterprise
 * already generates a client from them — renaming them would break that client
 * to say something the `currency` beside them already says.
 */
export interface BalanceView {
  name: string
  email: string
  paidCents: number
  owedCents: number
  /** Positive = the group owes them; negative = they owe the group. */
  netCents: number
}

export interface SettlementView {
  fromName: string
  fromEmail: string
  toName: string
  toEmail: string
  amountCents: number
}

/* ------------------------------ pure helpers ------------------------------ */

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
 * The widest amount either cents column can hold. They are `integer` (int4),
 * and money that overruns one is a Postgres `integer out of range` escaping as
 * an unhandled 500 — from a handler whose 422 already has a message field for
 * exactly this. CHF 21 million is not a friend-group budget; the bound is here
 * to make the refusal legible, not to be a policy.
 */
export const MAX_CENTS = 2_147_483_647

/**
 * The shape an exchange rate is allowed to take: at most nine digits before the
 * point and at most ten after, which is `numeric(20, 10)`, the column it lands
 * in.
 *
 * The fractional cap is not cosmetic. A rate with more decimals than the column
 * holds is silently ROUNDED on storage while `amount_base_cents` was computed
 * at full precision, so the row that comes back violates the invariant the
 * contract states — `amountCents × fxRate = amountBaseCents` — and no error is
 * raised anywhere. Refusing the input is the only way that pair stays true.
 */
const FX_RATE_PATTERN = /^\d{1,9}(?:\.\d{1,10})?$/

/**
 * `cents × rate`, rounded half up, with no floating point anywhere: the rate is
 * a decimal STRING and the multiplication runs in BigInt over its scale. A
 * `Number` multiplication is off by a cent often enough to matter on a
 * three-way split, and "off by a cent" in a settlement plan is a bug report.
 *
 * Throws 422 on a rate that is not a positive decimal of a storable shape, or
 * on a product that would not fit the column. The only caller that can produce
 * either is a human typing into the override field.
 */
export function convertCents(cents: number, rate: string): number {
  const trimmed = rate.trim()
  if (!FX_RATE_PATTERN.test(trimmed)) {
    throw createError({
      statusCode: 422,
      message: 'An exchange rate is a positive decimal number with at most 10 decimal places, like 0.9412'
    })
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)!
  const frac = m[2] ?? ''
  const numerator = BigInt(m[1] + frac)
  const denominator = 10n ** BigInt(frac.length)
  if (numerator === 0n) {
    throw createError({ statusCode: 422, message: 'An exchange rate cannot be zero' })
  }
  const scaled = BigInt(Math.round(cents)) * numerator
  const whole = scaled / denominator
  const remainder = scaled % denominator
  const converted = remainder * 2n >= denominator ? whole + 1n : whole
  if (converted > BigInt(MAX_CENTS)) {
    throw createError({ statusCode: 422, message: 'That amount and rate convert to more money than an expense can hold' })
  }
  return Number(converted)
}

/**
 * Re-express `parts` (which sum to `total`) so they sum to `newTotal` EXACTLY,
 * by largest remainder: floor each proportional share, then hand the leftover
 * cents out one at a time to the largest fractional parts.
 *
 * This is why shares are converted as a GROUP rather than one at a time.
 * Converting each share on its own rounds each one independently, and three
 * roundings of 3333.33 do not add up to the converted total — the budget then
 * shows a total nobody owes, which is exactly the kind of quiet cent that makes
 * a friend group stop trusting the numbers.
 */
export function apportionCents(parts: number[], total: number, newTotal: number): number[] {
  if (parts.length === 0) return []
  if (total <= 0) return parts.map(() => 0)
  const big = BigInt(total)
  const scaled = parts.map(p => BigInt(p) * BigInt(newTotal))
  const floors = scaled.map(v => v / big)
  const remainders = scaled.map(v => v % big)
  let leftover = BigInt(newTotal) - floors.reduce((sum, v) => sum + v, 0n)
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => (remainders[b]! === remainders[a]! ? a - b : (remainders[b]! > remainders[a]! ? 1 : -1)))
  const out = floors.map(v => v)
  for (const i of order) {
    if (leftover <= 0n) break
    out[i] = out[i]! + 1n
    leftover -= 1n
  }
  return out.map(Number)
}

/**
 * The shape a percentage or a weight may take: at most eight digits before the
 * point and four after, which is `numeric(12, 4)`, the column it lands in.
 *
 * Four decimals is what makes a percentage split of three people possible at
 * all — `33.3333` three times is not 100, so the honest entry is
 * `33.33/33.33/33.34`, and refusing more precision than the column holds keeps
 * the stored intent equal to the entered one. Same reasoning as `FX_RATE_PATTERN`.
 */
const WEIGHT_PATTERN = /^\d{1,8}(?:\.\d{1,4})?$/

/** `numeric(12, 4)`: every weight is compared and summed as an integer at this scale. */
const WEIGHT_SCALE = 10_000

/** 100%, at `WEIGHT_SCALE`. What a percentage split has to add up to. */
const FULL_PERCENT = 100 * WEIGHT_SCALE

/**
 * A percentage or weight as an integer at `WEIGHT_SCALE`, so the sum-to-100
 * check is exact. `33.33` is `333300`; no float ever touches it, because
 * `0.1 + 0.2 !== 0.3` is precisely the shape of bug that makes a split of a
 * dinner bill wrong by a cent and a friend group stop trusting the screen.
 */
function scaleWeight(value: string | number, label: string): number {
  const trimmed = `${value}`.trim()
  if (!WEIGHT_PATTERN.test(trimmed)) {
    throw createError({
      statusCode: 422,
      message: `${label} is a positive number with at most 4 decimal places, like 33.33`
    })
  }
  const [whole, frac = ''] = trimmed.split('.')
  return Number(whole) * WEIGHT_SCALE + Number(`${frac}0000`.slice(0, 4))
}

/** `333300` back to `'33.33'` — what gets stored, and what an edit reads back. */
function unscaleWeight(scaled: number): string {
  const whole = Math.floor(scaled / WEIGHT_SCALE)
  const frac = `${scaled % WEIGHT_SCALE}`.padStart(4, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** `'33.33'` as a share of 100, rendered for a refusal message. */
function percentText(scaled: number): string {
  return `${unscaleWeight(scaled)}%`
}

interface ResolvedShare {
  name: string
  email: string
  amountCents: number
  /** The entered percentage or weight, canonicalised; null under `even`/`exact`. */
  weight: string | null
}

/**
 * Deduplicate the participant list by email (first mention wins) and refuse an
 * empty one. Every mode starts here, so "Ana twice" cannot become two shares
 * under one mode and one under another.
 */
function cleanParticipants(participants: ExpenseParticipantInput[]): ExpenseParticipantInput[] {
  const seen = new Set<string>()
  const cleaned = participants
    .map(p => ({ ...p, email: p.email.toLowerCase() }))
    .filter((p) => {
      if (seen.has(p.email)) return false
      seen.add(p.email)
      return true
    })
  if (cleaned.length === 0) {
    throw createError({ statusCode: 422, message: 'An expense needs at least one participant' })
  }
  return cleaned
}

/**
 * Resolve an expense's participant list into materialised shares that sum to
 * `amountCents` EXACTLY, whichever mode was asked for.
 *
 * Every mode lands in the same place — a list of cents — because shares are
 * materialised at write time and a balance is a plain sum. The mode only
 * decides how the arithmetic gets there, and the cent-by-cent remainder
 * distribution (`splitEvenlyCents` for `even`, `apportionCents` for the
 * proportional modes) is what makes "exactly" true for every total, including
 * the ones that do not divide.
 *
 * Throws 422 on anything that does not add up, naming the sum it got: the
 * person typing 33/33/33 needs to be told it is 99, not that "something is
 * wrong".
 */
export function resolveShares(
  amountCents: number,
  participants: ExpenseParticipantInput[],
  splitMode: SplitMode = 'even'
): ResolvedShare[] {
  const cleaned = cleanParticipants(participants)

  if (splitMode === 'percentage' || splitMode === 'weight') {
    return resolveProportional(amountCents, cleaned, splitMode)
  }

  if (cleaned.some(p => p.weight !== undefined && p.weight !== null)) {
    throw createError({
      statusCode: 422,
      message: 'A percentage or weight only means something on a percentage or weight split'
    })
  }

  if (splitMode === 'exact' && cleaned.some(p => p.amountCents === undefined)) {
    throw createError({
      statusCode: 422,
      message: 'An exact split needs an amount for everybody it is split between'
    })
  }

  const fixed = cleaned.filter(p => p.amountCents !== undefined)
  const fixedSum = fixed.reduce((sum, p) => sum + (p.amountCents ?? 0), 0)
  if (fixed.some(p => (p.amountCents ?? 0) < 0)) {
    throw createError({ statusCode: 422, message: 'Shares cannot be negative' })
  }
  if (fixedSum > amountCents) {
    throw createError({ statusCode: 422, message: 'The explicit shares exceed the expense total' })
  }

  const flexible = cleaned.filter(p => p.amountCents === undefined)
  if (flexible.length === 0 && fixedSum !== amountCents) {
    throw createError({ statusCode: 422, message: 'The shares must add up to the expense total' })
  }

  const evenShares = splitEvenlyCents(amountCents - fixedSum, flexible.length)
  let flexIndex = 0
  return cleaned.map(p => ({
    name: p.name,
    email: p.email,
    amountCents: p.amountCents !== undefined ? p.amountCents : evenShares[flexIndex++]!,
    weight: null
  }))
}

/**
 * `percentage` and `weight`: the same arithmetic over the same column, differing
 * only in what the number has to add up to. Percentages must total 100; weights
 * may total anything above zero, because "Ana counts double" is 2/1/1 and
 * nobody should have to turn that into 50/25/25 themselves.
 *
 * The distribution is `apportionCents` — the very function that keeps converted
 * shares summing to the converted total — so the remainder lands cent by cent
 * on the largest fractional parts rather than on whoever happens to be last.
 */
function resolveProportional(
  amountCents: number,
  cleaned: ExpenseParticipantInput[],
  splitMode: 'percentage' | 'weight'
): ResolvedShare[] {
  const label = splitMode === 'percentage' ? 'A percentage' : 'A weight'
  if (cleaned.some(p => p.amountCents !== undefined)) {
    throw createError({
      statusCode: 422,
      message: `A ${splitMode} split takes ${splitMode === 'percentage' ? 'percentages' : 'weights'}, not per-person amounts`
    })
  }
  const weights = cleaned.map((p) => {
    if (p.weight === undefined || p.weight === null || `${p.weight}`.trim() === '') {
      throw createError({
        statusCode: 422,
        message: splitMode === 'percentage'
          ? `${p.name} has no percentage — give everybody one, or 0 to leave them out of this expense`
          : `${p.name} has no weight — give everybody one, or 0 to leave them out of this expense`
      })
    }
    return scaleWeight(p.weight, label)
  })

  const total = weights.reduce((sum, w) => sum + w, 0)
  if (splitMode === 'percentage' && total !== FULL_PERCENT) {
    throw createError({
      statusCode: 422,
      message: `Those percentages add up to ${percentText(total)}, not 100%`
    })
  }
  if (total <= 0) {
    throw createError({
      statusCode: 422,
      message: 'At least one person needs a weight above zero, or there is nobody to split this between'
    })
  }

  const shares = apportionCents(weights, total, amountCents)
  return cleaned.map((p, i) => ({
    name: p.name,
    email: p.email.toLowerCase(),
    amountCents: shares[i]!,
    weight: unscaleWeight(weights[i]!)
  }))
}

/**
 * Per-person balances (paid − owed) across a list of expenses, in BASE cents.
 *
 * This function used to add `amountCents` across every expense whatever
 * currency it named, which is the whole of #25. It reads `amountBaseCents` and
 * nothing else; the as-spent figures exist to be shown, never to be summed.
 */
export function computeBalances(expenses: ExpenseView[]): BalanceView[] {
  const byEmail = new Map<string, BalanceView>()
  const touch = (name: string, email: string): BalanceView => {
    let b = byEmail.get(email)
    if (!b) {
      b = { name, email, paidCents: 0, owedCents: 0, netCents: 0 }
      byEmail.set(email, b)
    }
    return b
  }
  for (const exp of expenses) {
    touch(exp.paidByName, exp.paidByEmail.toLowerCase()).paidCents += exp.amountBaseCents
    for (const share of exp.shares) {
      touch(share.name, share.email.toLowerCase()).owedCents += share.amountBaseCents
    }
  }
  const balances = [...byEmail.values()]
  for (const b of balances) b.netCents = b.paidCents - b.owedCents
  return balances.sort((a, b) => b.netCents - a.netCents)
}

/**
 * Greedy settlement plan: repeatedly match the largest debtor with the largest
 * creditor. Not guaranteed minimal in pathological cases, but at friend-group
 * scale it produces the short "A pays B" list people actually want.
 *
 * Base cents, like the balances it clears — a settlement is a single figure one
 * friend hands another, so it is stated in the one currency the instance
 * settles up in and never in the currency of whatever was bought.
 */
export function suggestSettlements(balances: BalanceView[]): SettlementView[] {
  const creditors = balances.filter(b => b.netCents > 0).map(b => ({ ...b }))
  const debtors = balances.filter(b => b.netCents < 0).map(b => ({ ...b }))
  const plan: SettlementView[] = []
  let ci = 0
  let di = 0
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!
    const debtor = debtors[di]!
    const amount = Math.min(creditor.netCents, -debtor.netCents)
    if (amount > 0) {
      plan.push({
        fromName: debtor.name,
        fromEmail: debtor.email,
        toName: creditor.name,
        toEmail: creditor.email,
        amountCents: amount
      })
    }
    creditor.netCents -= amount
    debtor.netCents += amount
    if (creditor.netCents === 0) ci++
    if (debtor.netCents === 0) di++
  }
  return plan
}

/**
 * A `numeric` column comes back from Postgres padded to its scale —
 * `'0.9412000000'` for the rate, `'2.0000'` for a weight — which is the same
 * number and a worse thing to show a person or hand a client. Trailing zeros
 * off, decimal point with them.
 */
function trimDecimal(stored: string): string {
  return stored.includes('.') ? stored.replace(/0+$/, '').replace(/\.$/, '') : stored
}

/* --------------------------------- reads ---------------------------------- */

/**
 * All expenses with their shares, plus balances and a settlement plan.
 *
 * `currency` is the INSTANCE BASE CURRENCY — the one thing every figure below
 * `expenses` is denominated in. It used to be `expenses[0]?.currency`, i.e.
 * whichever row came back first, which is how a budget could be labelled EUR
 * while the numbers under it were a sum of CHF and GBP cents.
 */
export async function loadBudget(eventId: string): Promise<{
  expenses: ExpenseView[]
  balances: BalanceView[]
  settlements: SettlementView[]
  /** The sum of every expense IN BASE CENTS. */
  totalCents: number
  /** The instance base currency: what `totalCents`, balances and settlements are in. */
  currency: string
}> {
  const db = useDb()
  const baseCurrency = await instanceBaseCurrency()
  const rows = await db
    .select({
      expense: tables.expense,
      addedByName: guestUser.name,
      addedByEmail: guestUser.email
    })
    .from(tables.expense)
    .leftJoin(guestUser, eq(tables.expense.createdByUserId, guestUser.id))
    .where(eq(tables.expense.eventId, eventId))
    .orderBy(asc(tables.expense.createdAt))

  const shares = rows.length
    ? await db
        .select()
        .from(tables.expenseShare)
        .where(inArray(tables.expenseShare.expenseId, rows.map(r => r.expense.id)))
    : []

  const expenses: ExpenseView[] = rows.map(({ expense: r, addedByName, addedByEmail }) => ({
    id: r.id,
    title: r.title,
    category: r.category as ExpenseCategory,
    amountCents: r.amountCents,
    currency: r.currency,
    amountBaseCents: r.amountBaseCents,
    baseCurrency: r.baseCurrency,
    fxRate: trimDecimal(r.fxRate),
    splitMode: r.splitMode,
    paidByName: r.paidByName,
    paidByEmail: r.paidByEmail,
    note: r.note,
    createdAt: r.createdAt,
    addedByName,
    addedByEmail: addedByEmail?.toLowerCase() ?? null,
    shares: shares
      .filter(s => s.expenseId === r.id)
      .map(s => ({
        name: s.name,
        email: s.email,
        amountCents: s.amountCents,
        amountBaseCents: s.amountBaseCents,
        weight: s.weight === null ? null : trimDecimal(s.weight)
      }))
  }))

  const balances = computeBalances(expenses)
  return {
    expenses,
    balances,
    settlements: suggestSettlements(balances),
    totalCents: expenses.reduce((sum, e) => sum + e.amountBaseCents, 0),
    currency: baseCurrency
  }
}

/**
 * What the expense form shows before anything is saved: the instance base
 * currency, and today's rate into it if one can be had.
 *
 * `rate: null` is an ordinary answer — the currency is not on the ECB's list,
 * the instance has no outbound network, frankfurter is down. The form then asks
 * for the rate by hand, and the write accepts it. Nothing about recording an
 * expense waits on this call succeeding.
 */
export async function quoteExpenseRate(currency: string): Promise<{
  currency: string
  baseCurrency: string
  rate: string | null
  asOf: string | null
}> {
  const baseCurrency = await instanceBaseCurrency()
  const from = normaliseCurrency(currency || baseCurrency)
  if (!isCurrencyCode(from)) {
    throw createError({ statusCode: 422, message: 'A currency is a three-letter code, like CHF or EUR.' })
  }
  if (from === baseCurrency) return { currency: from, baseCurrency, rate: '1', asOf: null }
  const quote = await fetchFxRate(from, baseCurrency)
  return { currency: from, baseCurrency, rate: quote?.rate ?? null, asOf: quote?.asOf ?? null }
}

/* --------------------------------- writes --------------------------------- */

/**
 * Who is recording this. Always an ACCOUNT since #48 — the invite capability
 * URL no longer writes money, so there is no longer an email-only actor and
 * `created_by_guest_email` is never written again.
 */
export interface ExpenseActor {
  userId: string
}

/** A signed-in account writing on the participant surface (`/api/me/**`). */
export interface ParticipantActor {
  id: string
  email: string
}

/**
 * Settle the conversion for one expense: which base currency it is being
 * recorded against, at what rate, and what that makes it worth.
 *
 * The outbound fetch happens HERE — before the transaction opens, and only when
 * there is something to convert. An expense in the base currency never leaves
 * the process, which is the ordinary case on an instance whose friends all
 * spend the same money; an expense carrying its own `fxRate` never leaves the
 * process either, which is the manual override AND the answer for an instance
 * with no outbound network. Only the remaining case asks frankfurter, once,
 * with a 2.5s ceiling — and when that comes back empty the write is refused
 * with a message naming the field to fill in rather than being recorded at a
 * rate nobody chose.
 */
async function resolveConversion(input: AddExpenseInput): Promise<{ currency: string, baseCurrency: string, fxRate: string, amountBaseCents: number }> {
  const baseCurrency = await instanceBaseCurrency()
  const currency = normaliseCurrency(input.currency ?? baseCurrency)
  if (!isCurrencyCode(currency)) {
    throw createError({ statusCode: 422, message: 'A currency is a three-letter code, like CHF or EUR.' })
  }

  let fxRate: string
  if (currency === baseCurrency) {
    fxRate = '1'
  } else if (input.fxRate !== undefined && input.fxRate !== null && `${input.fxRate}`.trim() !== '') {
    fxRate = `${input.fxRate}`.trim()
  } else {
    const quote = await fetchFxRate(currency, baseCurrency)
    if (!quote) {
      throw createError({
        statusCode: 422,
        message: `No ${currency} → ${baseCurrency} rate could be fetched just now. Enter the rate yourself and the expense will be recorded with it.`
      })
    }
    fxRate = quote.rate
  }

  return { currency, baseCurrency, fxRate, amountBaseCents: convertCents(input.amountCents, fxRate) }
}

/** Record an expense with materialised shares, in one transaction. */
export async function addExpense(eventId: string, input: AddExpenseInput, by: ExpenseActor) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw createError({ statusCode: 422, message: 'The amount must be a positive number of cents' })
  }
  if (input.amountCents > MAX_CENTS) {
    throw createError({ statusCode: 422, message: 'That is more money than one expense can hold' })
  }
  const splitMode = input.splitMode ?? 'even'
  const resolved = resolveShares(input.amountCents, input.participants, splitMode)
  const { currency, baseCurrency, fxRate, amountBaseCents } = await resolveConversion(input)
  // Apportioned as a group against the CONVERTED TOTAL, so the base shares add
  // up to it exactly — the same guarantee `resolveShares` gives in the currency
  // the money was actually spent in, whichever mode produced them. The two
  // guarantees compose: a 2/1/1 weighted EUR dinner sums to the euros spent AND
  // to the francs it settles for, and neither sum needs the other to be tidy.
  const baseShares = apportionCents(resolved.map(s => s.amountCents), input.amountCents, amountBaseCents)
  const expenseId = createId()
  const db = useDb()

  await db.transaction(async (tx) => {
    // The base was read (and the rate fetched) OUTSIDE this transaction, because
    // an outbound HTTP call must never be made with one open. Re-read it here
    // and refuse if it moved: without this, an expense recorded while the owner
    // is changing the instance base lands stamped with the old one — which is
    // this issue's bug, in one row, produced by a race rather than by the
    // arithmetic. See the note in `setInstanceBaseCurrency` for the half of
    // this window that a re-read alone cannot close.
    const current = await baseCurrencyWithin(tx)
    if (current !== baseCurrency) {
      throw createError({
        statusCode: 409,
        message: 'The instance base currency changed while this was being recorded. Try again.'
      })
    }
    await tx.insert(tables.expense).values({
      id: expenseId,
      eventId,
      title: input.title,
      category: input.category ?? 'other',
      amountCents: input.amountCents,
      currency,
      baseCurrency,
      fxRate,
      amountBaseCents,
      splitMode,
      paidByName: input.paidByName,
      paidByEmail: input.paidByEmail.toLowerCase(),
      note: input.note ?? null,
      createdByUserId: by.userId,
      createdByGuestEmail: null
    })
    await tx.insert(tables.expenseShare).values(resolved.map((share, i) => ({
      id: createId(),
      expenseId,
      eventId,
      name: share.name,
      email: share.email,
      amountCents: share.amountCents,
      amountBaseCents: baseShares[i]!,
      weight: share.weight
    })))
  })

  // The recorded expense's id rides along with the budget: the caller that
  // needs the budget ignores it, and the machine API — whose contract answers
  // the ONE expense just recorded — can find it without guessing at ordering.
  return { ...await loadBudget(eventId), expenseId }
}

/**
 * Remove an expense — the account that recorded it, the person it says paid,
 * or a planner. Its shares cascade away.
 */
export async function removeExpense(
  eventId: string,
  expenseId: string,
  by: { userId?: string, email?: string, asPlanner?: boolean }
) {
  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.expense)
    .where(and(eq(tables.expense.id, expenseId), eq(tables.expense.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'Expense not found' })

  const isRecorder = !!by.userId && row.createdByUserId === by.userId
  const isPayer = !!by.email && row.paidByEmail === by.email.toLowerCase()
  if (!isRecorder && !isPayer && !by.asPlanner) {
    throw createError({ statusCode: 403, message: 'Only the person who recorded this expense — or who paid it — can remove it' })
  }
  await db.delete(tables.expense).where(eq(tables.expense.id, expenseId))
}

/* --------------------------- planner-scoped shape --------------------------- */

/** Budget for a planner of the event — same `(userId, slug)` shape as events-data. */
export async function loadBudgetForPlanner(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return loadBudget(ev.id)
}

/** Record an expense as a planner (owner/co-planner only). */
export async function addExpenseAsPlanner(userId: string, slug: string, input: AddExpenseInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return addExpense(ev.id, input, { userId })
}

/** Remove an expense as a planner (owner/co-planner only). */
export async function removeExpenseAsPlanner(userId: string, slug: string, expenseId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return removeExpense(ev.id, expenseId, { asPlanner: true })
}

/* ------------------------- participant-scoped shape ------------------------ */

/**
 * Who may move money on the participant surface. `logistics` is absent on
 * purpose: `addExpenseAsPlanner` already refuses it on the host surface, and
 * two gates disagreeing about one verb is how a role restriction stops meaning
 * anything. A logistics planner who is genuinely on the trip has an RSVP, and
 * `assertParticipant` answers `participant` for them.
 */
const EXPENSE_WRITERS: readonly ParticipantRole[] = ['participant', 'owner', 'co_planner']

/**
 * The standing every participant-surface expense write needs: the event is open
 * to the people invited to it, and this account is one of them.
 *
 * The lifecycle half used to come free with `resolveInviteToken`; it does not
 * come free here, and without it an expense records happily against a cancelled
 * trip (#48 review).
 */
async function assertMayWriteExpenses(slug: string, actor: ParticipantActor) {
  const ev = await loadEventBySlug(slug)
  assertEventOpenToGuests(ev)
  const role = await assertParticipant(ev.id, actor.id)
  if (!EXPENSE_WRITERS.includes(role)) {
    throw createError({ statusCode: 403, message: 'Your role on this event does not cover the budget' })
  }
  return { ev, role }
}

/**
 * Record an expense as a signed-in PARTICIPANT of the event (#48). The gate is
 * `assertParticipant`, not `assertPlanner`: a friend on a trip is not a
 * planner, and the invite link is no longer a licence to write money.
 *
 * `input.paidBy*` is deliberately free of the actor — "Ana paid €40, I'm
 * entering it" is the convenience that keeps the gate from being annoying, and
 * `createdByUserId` records who actually typed it.
 */
export async function addExpenseAsParticipant(actor: ParticipantActor, slug: string, input: AddExpenseInput) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  return addExpense(ev.id, input, { userId: actor.id })
}

/** Remove an expense you recorded or paid; a planner of the event may remove any. */
export async function removeExpenseAsParticipant(actor: ParticipantActor, slug: string, expenseId: string) {
  const { ev, role } = await assertMayWriteExpenses(slug, actor)
  await removeExpense(ev.id, expenseId, {
    userId: actor.id,
    email: actor.email,
    asPlanner: role === 'owner' || role === 'co_planner'
  })
  return loadBudget(ev.id)
}
