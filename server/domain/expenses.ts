import { and, asc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { instanceBaseCurrency } from './instance-settings'
import { guestUser } from '../database/schema/auth'
import { assertEventOpenToGuests, assertParticipant, assertPlanner, loadEventBySlug, type ParticipantRole } from './permissions'
import {
  type AccountKind,
  type AccountView,
  ensureEventAccountsWithin,
  ensureMemberAccountsWithin,
  loadEventAccounts,
  resolveCategoryAccount,
  ROUNDING
} from './accounts'
import {
  confirmMediaUpload,
  listReceiptsByExpense,
  type MediaItemView,
  pinReceipt,
  registerMediaUpload,
  unpinReceipt
} from './media'
import { fetchFxRate, isCurrencyCode, normaliseCurrency } from '../utils/fx'
import { FULL_PERCENT, scaleWeight as scaleWeightOrNull, unscaleWeight } from '../../shared/utils/split-weight'
import { wasConverted } from '../../shared/utils/conversion'
import { isPlainEvenSplit, splitEvenlyCents } from '../../shared/utils/even-split'
import { settlementTitle } from '../../shared/utils/settlement'

/**
 * The trip budget: expenses someone fronted, split across participants, and
 * the resulting who-owes-whom. Money is integer cents throughout (no float
 * money); shares are materialised at write time so balances are a plain sum.
 * Identity is the same name+email pair RSVPs use.
 *
 * MIXED CURRENCIES (#25, repointed by #59). An expense is recorded in the
 * currency it was spent in and converted ONCE, at write time, into THE EVENT'S
 * currency (`events_event.currency`). Both the rate and the converted amount
 * are frozen onto the row, and every balance, settlement and total in this file
 * is computed from `amountBaseCents` alone. `currency` used to be stored, typed
 * and rendered while nothing summed with it — one €120 dinner on a CHF trip was
 * added as 12000 CHF cents, confidently and silently.
 *
 * The currency belongs to the TRIP, not to the instance: a ski week in Chamonix
 * settles in EUR whether or not the friends live in Switzerland, and the
 * instance setting is now only what a new event STARTS with. The row columns
 * keep the names `baseCurrency`/`amountBaseCents` — Enterprise generates a
 * client from them, and renaming them would break another repository to say
 * something the `currency` beside them already says.
 *
 * WHAT IS SPLIT IS WHAT THE PAYER ACTUALLY PAID (#59). A bank that charged
 * `price × rate × fee` took that whole figure out of somebody's account, and
 * that is what the group owes them — you would not tell a friend the VAT on
 * dinner was a them problem. So the fetched rate is a SUGGESTION: the person
 * who paid may state the rate, or state the out-of-pocket total outright, and
 * either overrides the lookup. `fxRateSource` records which, so a later reader
 * knows which rows were checked against a statement.
 *
 * SPLIT MODES (#26). An expense can be divided evenly, by exact per-person
 * amounts, by percentage, or by weight. All four are resolved to cents by
 * `resolveShares` at write time and stored materialised, so nothing downstream
 * — a balance, a settlement, a total — knows there is more than one mode. What
 * the person meant is kept beside the amounts (`splitMode` on the expense, the
 * entered `weight` on each share) so the screen can name the mode and an edit
 * can start from it; no read ever computes money from either.
 *
 * That record is COMPLETE for `percentage` and `weight` (the numbers are on the
 * shares) and for `exact` (the amounts are the shares). It is NOT complete for
 * `even`, which honours explicit per-person amounts and splits the remainder
 * across the rest: nothing records which participants were pinned, so a mixed
 * `even` expense is the one an edit cannot re-split without asking again.
 *
 * A DOUBLE-ENTRY LEDGER (#61). The two tables above were already a journal
 * header with lines — the payer is the credit, each share a debit, and "the
 * shares sum to the total" is the balance check — so what this file gained was
 * ACCOUNTS (`server/domain/accounts.ts`), not a new structure. Every line now
 * posts a SIGNED amount to a member, category or rounding account, and the
 * lines of an entry sum to zero in both currencies. That one invariant
 * (`assertEntryBalances`, refused at write time) is what makes every figure
 * below a sum over accounts:
 *
 *   trip total   sum of DEBITS into category accounts
 *   balances     per member account: credits paid, debits owed
 *   settlements  member to member, touching no category account — which is why
 *                a transfer between friends is structurally not a cost and
 *                needs no `kind` flag to be left out of the total. #28 writes
 *                them, in `server/domain/settlements.ts`, through the write
 *                path below and not a second one
 *
 * And an entry that does not add up has somewhere honest to put the difference:
 * the event's `Rounding` account. Nothing on this path ever produces one — the
 * base shares are still converted as a group (#25), so they sum to the
 * converted total exactly — and that is the point. The residual is COMPUTED
 * rather than assumed, so the mechanism is there for #59, where changing a
 * trip's currency recomputes per-person amounts that were rounded against a
 * total that no longer exists. See `buildEntryLines`.
 */

/**
 * CORRECTING ONE (#27). An expense used to be add-or-delete, so fixing 84.50
 * into 48.50 meant destroying the row and rebuilding it — losing who recorded
 * it, when, and the rate frozen onto it. `updateExpense` REWRITES THE ENTRY IN
 * PLACE: the header keeps its id, its `created_at` and its `created_by_user_id`,
 * and its lines are rebuilt from scratch by the same `buildEntryLines` /
 * `assertEntryBalances` pair every other write goes through.
 *
 * A REPLACEMENT RATHER THAN A CORRECTING ENTRY, and the reason is that nothing
 * else here is append-only either: `removeExpense` deletes the row outright and
 * `setEventCurrency` deletes and re-inserts every line of every entry on the
 * trip. A reversal-plus-restatement would make the edit the one operation that
 * preserved history, in a ledger where history is not preserved — and it would
 * put two extra entries on the screen per correction and make the trip total
 * (the sum of category debits) count the mistake and its reversal unless a
 * `kind` flag told it not to, which is exactly the flag #61 designed out.
 *
 * WHO CHANGED IT IS THE AUDIT'S JOB, not a column here: `server/middleware/
 * audit.ts` records the human surfaces at the edge and `defineServiceHandler`
 * the machine one, so `created_by_user_id` goes on meaning what it says (who
 * ADDED it) and no migration is needed to say who edited it.
 *
 * NO LOCK-OUT ONCE PEOPLE HAVE SETTLED UP, following #59: the balances and the
 * plan re-derive from the rewritten entry like they re-derive from a currency
 * change, and a correction made halfway through settling is fixed by peer
 * pressure rather than by a refusal from this program.
 */

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

/**
 * Where an entry's conversion came from (#59).
 *
 * - `fetched` — this instance derived it: a rate looked up at write time, an
 *   identity conversion (the receipt was already in the event's currency), or a
 *   recomputation this instance did when the trip's currency changed.
 * - `manual` — a PERSON stated it, by typing the rate or by typing what came
 *   out of their account. It is the figure that was checked against a
 *   statement, so nothing re-derives it from the receipt afterwards.
 *
 * Two values and not three: the question a later reader asks is "did somebody
 * verify this against a statement", and typing the rate and typing the amount
 * answer it the same way.
 */
export type FxRateSource = 'fetched' | 'manual'

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
  /**
   * Where the cost lands, BY NAME, case-insensitively — "Food", or the old
   * lower-case enum value `food`, which still resolves. `other` resolves to
   * `Uncategorised`, which is also what an omitted category means.
   *
   * Omitting it is the ordinary case and the reason the screen never has to ask
   * (#61): every line still posts somewhere, so `accountId` on a line can be
   * NOT NULL without a group that does not care about categories ever meeting
   * the concept.
   */
  category?: string | null
  /** The category account outright, when the caller has its id. Wins over `category`. */
  accountId?: string | null
  /** The total AS SPENT, in `currency`. */
  amountCents: number
  /** What was handed over. Defaults to the EVENT's currency. */
  currency?: string
  /**
   * The rate from `currency` into the event's currency, supplied by hand. Omit
   * it and the rate is fetched once at write time; supply it and NOTHING is
   * fetched, which is both the override and the answer to an instance with no
   * outbound network.
   */
  fxRate?: string | number
  /**
   * WHAT THE PAYER WAS ACTUALLY OUT OF POCKET, in the event's currency (#59).
   *
   * The other override, and the one a person reading their card statement
   * reaches for: a bank charging `price × rate × fee` hands over a number no
   * single mid-market rate reproduces, and THAT is the number the group splits.
   * Given it, nothing is fetched, `fxRate` is derived from the pair so the row
   * still says what one unit cost, and `fxRateSource` records `manual`.
   *
   * Refused beside `fxRate`: the two can contradict each other and picking one
   * silently is how a budget stops meaning anything.
   */
  targetAmountCents?: number
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

/**
 * A CORRECTION to an entry that already exists (#27). Every field is optional
 * and ABSENT MEANS UNCHANGED — which is the whole difficulty, because `null` is
 * a value two of them can take: `note: null` clears the note, and `category:
 * null` moves the cost to `Uncategorised`, while leaving either out keeps what
 * is there. A PATCH that sent `{}` would rewrite the entry to itself.
 *
 * THE MONEY FIELDS BEHAVE AS A GROUP, and `resolveEditConversion` below is the
 * one place that decides how. In short: say what it cost and the row records
 * your figure; move the receipt's currency and the rate is settled afresh;
 * change only the amount and the rate this row was frozen at carries the new
 * one.
 *
 * `splitMode` WITHOUT `participants` IS REFUSED. Changing how a total is
 * divided is a statement about people and numbers, and the mode alone does not
 * carry either — `percentage` with nothing behind it would have to invent the
 * percentages. Leave both out and the split is re-derived from the record
 * (`resplitFromRecord`), which is the ordinary edit.
 */
export interface UpdateExpenseInput {
  title?: string
  /** `null` moves the cost to `Uncategorised`; absent leaves it where it is. */
  category?: string | null
  /** The category account outright. Wins over `category`. `null` is `Uncategorised`. */
  accountId?: string | null
  /** The new total AS SPENT, in `currency`. */
  amountCents?: number
  /** The currency the receipt is in. Changing it settles the conversion afresh. */
  currency?: string
  /** The rate, stated. Records the row as `manual` — a figure somebody checked. */
  fxRate?: string | number
  /** What the payer was out of pocket, stated. Also `manual`. Refused beside `fxRate`. */
  targetAmountCents?: number
  note?: string | null
  /** Who fronted it. Both halves together or neither: an account needs a name. */
  paidByName?: string
  paidByEmail?: string
  /** Only ever beside `participants`; see above. */
  splitMode?: SplitMode
  /** The split, restated. Omit it and it is re-derived from what was recorded. */
  participants?: ExpenseParticipantInput[]
}

export interface ExpenseView {
  id: string
  /**
   * What the entry is called. A cost's is typed by a person; a TRANSFER's is
   * derived from the two people in it (`settlementTitle`) and re-derived on
   * every write, so it cannot go on naming a pair that has been corrected.
   */
  title: string
  /**
   * The NAME of the category account this entry's cost was debited to, and
   * `null` for an entry that has no category line at all — which is what a
   * payment between two people is (#28). It used to answer `Uncategorised`
   * there, which is the name of a real account this entry never touched.
   */
  category: string | null
  /**
   * That account's id — the thing "what did accommodation cost" sums over.
   * `null` only for an entry with no category line at all, which is what a
   * transfer between two friends IS: `server/domain/settlements.ts` writes
   * them (#28), and `shared/utils/settlement.ts` is the one rule that reads
   * this field to tell the two apart.
   */
  categoryAccountId: string | null
  /** As spent, in `currency`. */
  amountCents: number
  currency: string
  /**
   * As settled: the frozen conversion of `amountCents` into `baseCurrency` —
   * which is the EVENT's currency (#59), not the instance's.
   */
  amountBaseCents: number
  baseCurrency: string
  /**
   * The rate this row was converted at, as a decimal string. `'1'` when the
   * receipt is already in the event's currency; the EFFECTIVE rate, derived
   * from the pair, when somebody stated the out-of-pocket total instead.
   */
  fxRate: string
  /**
   * Where that rate came from (#59). `manual` means a person stated it — the
   * rate or the amount their bank actually took — and it is the row somebody
   * checked against a statement. `fetched` means this instance derived it: a
   * lookup, an identity conversion, or a recomputation after the trip's
   * currency changed.
   */
  fxRateSource: FxRateSource
  /**
   * What the payer SAID they were out of pocket, and the currency they said it
   * in — `null` on a `fetched` row (#59 review).
   *
   * `amountBaseCents` is re-derived by every currency change; this is not. It
   * is the only place the typed figure survives, and it is here so a reader can
   * see the difference rather than being told a chained conversion was checked
   * against a statement.
   */
  statedAmountCents: number | null
  statedCurrency: string | null
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
  /**
   * The member DEBIT lines of this entry, which is what "a share" has always
   * meant — who owes what. The name and the email come from the member account
   * now; the line itself carries neither.
   */
  shares: Array<{
    name: string
    email: string
    amountCents: number
    amountBaseCents: number
    /** The percentage or share count entered for this person, or null. */
    weight: string | null
  }>
  /**
   * EVERY line of the entry, credits included, in the order they were written.
   * This is the ledger itself: it sums to zero, and a reader that wants to know
   * where the money went reads it rather than reconstructing it from the fields
   * above. The residual line on `Rounding`, when there is one, is only here.
   */
  lines: LedgerLineView[]
  /**
   * THE RECEIPT (#29): the gallery photo or shared paper pinned to this entry,
   * or `null`. "What was that 84 francs?" is the question every shared budget
   * asks, and this is the answer somebody already photographed.
   *
   * A STORAGE KEY, NOT A URL. Media download URLs are signed and expire, like
   * every other media read in this app, and the signing happens one layer out
   * (`signBudgetReceipts` in `server/utils/media-sign.ts`) because the domain
   * has no object store. A handler that returns a budget to a browser signs it;
   * `/api/v1` deliberately does not, and its projection drops this field whole
   * — no bytes cross that boundary, exactly as `listMedia` already says.
   *
   * It says NOTHING about the money. `fxRateSource` and the stated pair mean a
   * person stated a figure and checked it; a photograph is evidence a reader
   * can look at, and pinning one relabels nothing (#71).
   */
  receipt: MediaItemView | null
}

/** One posting: a signed amount into one account. Debit positive, credit negative. */
export interface LedgerLine {
  accountId: string
  /** As spent, signed. */
  amountCents: number
  /** In base cents, signed. */
  amountBaseCents: number
  /** The entered percentage or weight, on member debit lines only. */
  weight: string | null
}

/** A line with the account it posts to, for anything that renders or sums it. */
export interface LedgerLineView extends LedgerLine {
  accountName: string
  accountKind: AccountKind
  /** The member's address, or null on a category or rounding line. */
  accountEmail: string | null
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
 *
 * Re-exported from `shared/utils/even-split.ts`, where it moved with
 * `isPlainEvenSplit` (#27): the expense form has to reach the same answer about
 * a recorded split that this file does, and the two agreeing by coincidence is
 * how money starts moving between friends. Callers here are unchanged.
 */
export { splitEvenlyCents } from '../../shared/utils/even-split'

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
 * The rate that takes `amountCents` to `targetCents`, as a decimal string at the
 * scale the column holds — the EFFECTIVE rate behind a figure somebody typed
 * off a bank statement (#59).
 *
 * `120.00 → 113.47` is `0.9455833333`, which is the mid-market rate plus the
 * bank's cut, and saying so on the row is more useful than storing the
 * mid-market rate beside a total it does not produce. It is a record, never an
 * input: the stated target is what the group splits, and nothing multiplies by
 * this to get back to it.
 *
 * Throws 422 on a pair whose ratio will not fit `numeric(20, 10)` — a hundred
 * million to one, which is not a holiday.
 */
export function deriveRate(amountCents: number, targetCents: number): string {
  if (amountCents <= 0) {
    throw createError({ statusCode: 422, message: 'The amount must be a positive number of cents' })
  }
  const scale = 10n ** 10n
  const numerator = BigInt(Math.round(targetCents)) * scale
  const denominator = BigInt(amountCents)
  const whole = numerator / denominator
  const remainder = numerator % denominator
  const scaled = remainder * 2n >= denominator ? whole + 1n : whole
  const text = `${scaled / scale}.${`${scaled % scale}`.padStart(10, '0')}`
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '')
  if (!FX_RATE_PATTERN.test(trimmed) || trimmed === '0') {
    throw createError({
      statusCode: 422,
      message: 'That amount and that total do not make a rate this can record. Check both figures.'
    })
  }
  return trimmed
}

/**
 * Re-express `parts` (which sum to `total`) so they sum to `newTotal` EXACTLY,
 * by largest remainder: floor each proportional share, then hand the leftover
 * cents out one at a time to the largest fractional parts.
 *
 * This is how a percentage or a weight becomes cents that sum to the total
 * EXACTLY: 33.33/33.33/33.34 of a total that does not divide still adds up,
 * because the leftover cents are handed to the largest fractional parts rather
 * than to whoever happens to be last.
 *
 * It is also how the base shares of one entry are produced on the write path:
 * `apportionCents(shares, sumOfShares, convertedTotal)` sums to the converted
 * total exactly, so nothing is left over. It is the SINGLE rounding path in
 * this file and there is deliberately no second one.
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
 * The scale and shape a percentage or weight is entered at live in
 * `shared/utils/split-weight.ts`, because the form has to reach the SAME answer
 * to show a running total — `99% of 100%` under the rows beats a refusal after
 * the save. This file owns the refusal; that one owns the rule.
 */
function scaleWeight(value: string | number, label: string): number {
  const scaled = scaleWeightOrNull(value)
  if (scaled === null) {
    throw createError({
      statusCode: 422,
      message: `${label} is a positive number with at most 4 decimal places, like 33.33`
    })
  }
  return scaled
}

/** `'33.33'` as a share of 100, rendered for a refusal message. */
function percentText(scaled: number): string {
  return `${unscaleWeight(scaled)}%`
}

export interface ResolvedShare {
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
 * The distribution is `apportionCents`, so the remainder lands cent by cent on
 * the largest fractional parts rather than on whoever happens to be last.
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
 * RE-SPLIT AN EDITED EXPENSE THE WAY IT WAS SPLIT IN THE FIRST PLACE (#27) —
 * or say, in so many words, that the record cannot answer.
 *
 * This is where `splitMode` and the entered `weight` #26 stored finally get
 * read. Changing a four-way even split from 100 to 120 gives four shares of 30,
 * not four of 25 and an orphaned 20; a 3/2/1 weight split re-apportions at the
 * same weights; percentages re-apply. The arithmetic is `resolveShares`, so
 * there is no second rounding path and every guarantee it makes holds here.
 *
 * WHAT THE RECORD CANNOT ANSWER, enumerated rather than summarised, because
 * three of the four modes can and one cannot:
 *
 *  - `percentage`, `weight` — complete. The numbers are on the shares.
 *  - `exact` — the amounts ARE the split, and they were chosen against a total
 *    that no longer exists. Apportioning them to the new one would silently
 *    turn "Ana's half of the room, Ben's single" into a proportional split
 *    nobody asked for, so a new total is REFUSED until the amounts come with
 *    it.
 *  - `even` — honours explicit per-person amounts and splits the remainder
 *    across the rest, recording nothing about which participants were pinned
 *    (#26, and the comment on `events_expense.split_mode` says so). A plain
 *    even split IS recoverable, and the shares themselves say whether it was
 *    one: if they are exactly what `splitEvenlyCents` produces for the old
 *    total then no one was pinned — or somebody was pinned at precisely their
 *    even share, which is the same entry and rightly gets the same answer.
 *    Anything else is refused, naming what is missing.
 *
 * AN UNCHANGED TOTAL NEEDS NO RE-SPLIT AT ALL, and that is not a shortcut: it
 * is what lets the title, the category, the note and the payer of a mixed
 * `even` expense be corrected without anybody being asked to type the split
 * again for a number that did not move.
 *
 * Pure, and exported for that reason: the whole of "what #26 did and did not
 * record" is decidable from four values, and a unit test reddens in 300ms what
 * would otherwise need a built server and a live Postgres.
 */
export function resplitFromRecord(input: {
  splitMode: SplitMode
  /** The total the entry is being corrected TO, as spent. */
  amountCents: number
  /** The total it was split against when it was recorded. */
  previousAmountCents: number
  /** Its member debit lines, in the order they were written. */
  shares: Array<{ name: string, email: string, amountCents: number, weight: string | null }>
}): ResolvedShare[] {
  const { splitMode, amountCents, previousAmountCents, shares } = input
  if (shares.length === 0) {
    throw createError({
      statusCode: 422,
      message: 'This expense has nobody to split between any more. Send the split with the change.'
    })
  }
  if (amountCents === previousAmountCents) {
    return shares.map(s => ({ name: s.name, email: s.email, amountCents: s.amountCents, weight: s.weight }))
  }

  const people = shares.map(s => ({ name: s.name, email: s.email }))
  if (splitMode === 'percentage' || splitMode === 'weight') {
    // A row of this mode always carries its numbers — `resolveProportional`
    // refuses to write one that does not. Reaching this with a null weight
    // means the row was written by something else, and guessing at it would be
    // worse than asking.
    if (shares.some(s => s.weight === null)) {
      throw createError({
        statusCode: 422,
        message: `This expense says it was split by ${splitMode} but does not carry the numbers. Send the split with the new total.`
      })
    }
    return resolveShares(
      amountCents,
      shares.map(s => ({ name: s.name, email: s.email, weight: s.weight! })),
      splitMode
    )
  }

  if (splitMode === 'even') {
    if (isPlainEvenSplit(shares.map(s => s.amountCents), previousAmountCents)) {
      return resolveShares(amountCents, people, 'even')
    }
    throw createError({
      statusCode: 422,
      message: 'This expense was split evenly with some amounts fixed by hand, and which ones was never recorded. Send the split with the new total.'
    })
  }

  throw createError({
    statusCode: 422,
    message: 'This expense was split by exact amounts, so a new total needs those amounts again. Send the split with it.'
  })
}

/* ------------------------------ the ledger -------------------------------- */

/**
 * The lines one expense becomes, in the ACCUMULATING shape the owner chose.
 *
 *     Ana pays 120 for dinner, split 4 ways
 *       credit  member:Ana        120     ← she fronted it
 *       debit   category:Food     120     ← THE COST
 *       credit  category:Food     120     ← pushed back out to the people
 *       debit   member:Ana         30
 *       debit   member:Ben         30
 *       debit   member:Cleo        30
 *       debit   member:Dee         30
 *
 * The category account accumulates rather than netting to zero, so the trip
 * total is the sum of DEBITS into category accounts. A transfer between two
 * friends will be an entry with member lines only — no category line, therefore
 * structurally not a cost, therefore no `kind` flag to forget to set.
 *
 * WHAT THE ROUNDING ACCOUNT IS FOR. An entry must balance, so an entry whose
 * lines do not add up needs somewhere honest to put the difference rather than
 * a creditor to quietly absorb it. `buildEntryLines` posts any such residual to
 * the event's `Rounding` account.
 *
 * ON THE WRITE PATH IT NEVER HAS ANYTHING TO DO, and that is the correct
 * outcome rather than a criterion going unmet. The base shares are converted AS
 * A GROUP (`apportionCents`, #25), so they sum to the converted total exactly,
 * and the residual is structurally zero for every expense recorded through
 * here. Converting each share on its own INSTEAD would not surface a rounding
 * artefact: it would invent a cent of liability and file it under a name that
 * makes it look discovered. Three people would severally owe CHF 83.68 for a
 * thing that cost 83.67, the payer would be credited 83.68 for handing over
 * 83.67, and `paidCents` would stop meaning what they paid.
 *
 * THE BRANCH EARNS ITS KEEP ON THE RECOMPUTE (#59,
 * `server/domain/event-currency.ts`). There the per-person figures are not
 * being derived from a total — they already exist, as debts people may have
 * settled against — so each is re-expressed at the day's rate on its own and
 * the total is re-expressed beside them. Converting eleven numbers at one rate
 * does not give the same answer as converting their sum, and that difference is
 * a real artefact of the change rather than liability conjured out of a split.
 * It goes on `Rounding`, where somebody can read it.
 */
export function buildEntryLines(input: {
  /** The entry total AS SPENT. */
  amountCents: number
  /** The entry total in base cents: what the payer was out of pocket. */
  amountBaseCents: number
  payerAccountId: string
  /**
   * Where the cost lands. `null` writes NO category line at all, which is what
   * a transfer between two friends is: member to member, structurally not a
   * cost, excluded from the trip total with no flag to forget (#28). That is
   * what `recordSettlement` passes, through `addExpense`'s `destination`.
   */
  categoryAccountId: string | null
  roundingAccountId: string
  /**
   * The member debits. `amountBaseCents` on a share is the RECOMPUTE path
   * handing in a figure it computed itself (below); omit it — which every write
   * does — and the group apportionment runs.
   */
  shares: Array<{ accountId: string, amountCents: number, amountBaseCents?: number, weight: string | null }>
}): LedgerLine[] {
  const spentOut = input.shares.reduce((sum, s) => sum + s.amountCents, 0)
  // Converted AS A GROUP, so the base shares sum to the converted total exactly
  // whatever the split was (#25). Converting each on its own rounds each one
  // independently, and three roundings of 3333.33 do not add up — which is a
  // total nobody owes, not a residual worth booking.
  //
  // UNLESS the caller already knows each share's figure. #59's recompute does:
  // by then each debit is a debt somebody may have settled against, so it is
  // re-expressed one at a time rather than re-apportioned, and the cents that
  // leaves over is a real artefact with a home rather than money moved between
  // people behind their backs.
  const given = input.shares.every(s => s.amountBaseCents !== undefined)
  const shareBase = given
    ? input.shares.map(s => s.amountBaseCents!)
    : apportionCents(input.shares.map(s => s.amountCents), spentOut, input.amountBaseCents)
  const owed = shareBase.reduce((sum, c) => sum + c, 0)

  const lines: LedgerLine[] = [
    // The payer is credited what the group owes them, which is the sum of the
    // debits below — that is what makes the member side of every entry net to
    // zero, and the balances with it, WHATEVER the residual turns out to be.
    // That is why the residual can never stop a settlement plan closing.
    { accountId: input.payerAccountId, amountCents: -input.amountCents, amountBaseCents: -owed, weight: null }
  ]
  if (input.categoryAccountId) {
    lines.push(
      { accountId: input.categoryAccountId, amountCents: input.amountCents, amountBaseCents: input.amountBaseCents, weight: null },
      // What was pushed back out, which is what the people below are debited —
      // the same figure as the cost for anything `resolveShares` produced, and
      // not assumed to be, so both columns close whatever this is handed.
      { accountId: input.categoryAccountId, amountCents: -spentOut, amountBaseCents: -owed, weight: null }
    )
  }
  lines.push(...input.shares.map((s, i) => ({
    accountId: s.accountId,
    amountCents: s.amountCents,
    amountBaseCents: shareBase[i]!,
    weight: s.weight
  })))

  // Zero for everything the WRITE path builds, and computed rather than
  // assumed. On the recompute it is the difference between what the payer was
  // out of pocket and the sum of eleven debts converted one at a time, which
  // is where the `Rounding` account finally earns its keep (#59).
  //
  // A transfer has no category line and therefore no gap to book: its own
  // credit is by construction the sum of its debits.
  //
  // WHICH MEANS THE ZERO-SUM CHECK IS WEAKER ON A TRANSFER, and the next person
  // to widen what a transfer may be has to know it (#74 review). With no
  // category line the base column closes for ANY shares — the payer is credited
  // `-owed`, the debits sum to `owed` — so `assertEntryBalances` cannot see a
  // header `amountBaseCents` that disagrees with them, and nothing is booked to
  // `Rounding` to say so. It is safe only because a transfer has EXACTLY ONE
  // share: `apportionCents([x], x, target)` is `[target]` exactly, so the sum
  // of the debits IS the header. Two shares and the two could drift a cent
  // apart silently. `updateExpense` refuses a second participant on a
  // category-less entry for this reason as much as for the visible ones, and
  // `recordSettlement` only ever writes one.
  const residual = input.categoryAccountId ? owed - input.amountBaseCents : 0
  if (residual !== 0) {
    lines.push({ accountId: input.roundingAccountId, amountCents: 0, amountBaseCents: residual, weight: null })
  }
  return lines
}

/**
 * THE INVARIANT: the lines of an entry sum to zero — in what was handed over
 * and in what it settles for, independently.
 *
 * In double-entry this one check catches most of what you would otherwise hunt
 * for a case at a time: a split that does not cover the total, a conversion
 * that lost a cent, a line posted to the wrong side. It is a 500 rather than a
 * 422 on purpose — every input that can be wrong has already been refused by
 * `resolveShares` and `convertCents` with a message naming the field, so an
 * entry that reaches here unbalanced is this file's bug and not the caller's.
 */
export function assertEntryBalances(lines: LedgerLine[]): void {
  const spent = lines.reduce((sum, l) => sum + l.amountCents, 0)
  const base = lines.reduce((sum, l) => sum + l.amountBaseCents, 0)
  if (spent !== 0 || base !== 0) {
    throw createError({
      statusCode: 500,
      message: `This entry does not balance (${spent} as spent, ${base} in base). Nothing was recorded.`
    })
  }
}

/**
 * Per-person balances, in BASE cents, summed over MEMBER ACCOUNTS.
 *
 * A credit on a member account is money they put in; a debit is money they owe.
 * That is the whole calculation now — there is no "payer" special case left,
 * because fronting the money IS a credit line like any other. It reads only
 * `amountBaseCents`: the as-spent figures exist to be shown, never to be summed
 * (which is the whole of #25).
 */
export function computeBalances(lines: LedgerLineView[]): BalanceView[] {
  const byEmail = new Map<string, BalanceView>()
  for (const line of lines) {
    if (line.accountKind !== 'member') continue
    const email = (line.accountEmail ?? '').toLowerCase()
    let b = byEmail.get(email)
    if (!b) {
      b = { name: line.accountName, email, paidCents: 0, owedCents: 0, netCents: 0 }
      byEmail.set(email, b)
    }
    if (line.amountBaseCents < 0) b.paidCents += -line.amountBaseCents
    else b.owedCents += line.amountBaseCents
  }
  const balances = [...byEmail.values()]
  for (const b of balances) b.netCents = b.paidCents - b.owedCents
  return balances.sort((a, b) => b.netCents - a.netCents)
}

/**
 * What the trip cost: the sum of DEBITS into category accounts.
 *
 * Not the category accounts' net (which is a cent of conversion residual away
 * from zero by design) and not the sum of what members owe (which includes that
 * residual). Debits into categories are the money that was actually spent on
 * something, and a member-to-member transfer touches no category account at
 * all, so it is excluded without anything having to know it exists.
 */
export function computeTotalCents(lines: LedgerLineView[]): number {
  return lines.reduce(
    (sum, l) => (l.accountKind === 'category' && l.amountBaseCents > 0 ? sum + l.amountBaseCents : sum),
    0
  )
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
 * The whole budget: every entry with its lines, the accounts they post to,
 * per-member balances and a settlement plan.
 *
 * `currency` is THE EVENT'S CURRENCY (#59) — the one thing every figure below
 * `expenses` is denominated in. It used to be `expenses[0]?.currency`, i.e.
 * whichever row came back first, which is how a budget could be labelled EUR
 * while the numbers under it were a sum of CHF and GBP cents; #25 made it the
 * instance's, and #59 moved it to where the answer actually differs.
 *
 * Every figure here is now a sum over accounts (#61). The accounts are SEEDED
 * on the way through when this event has never had a budget looked at — events
 * are created down four different paths and an account that exists on three of
 * them is worse than none — which is why a read touches `ensureEventAccounts`.
 */
export async function loadBudget(eventId: string): Promise<{
  expenses: ExpenseView[]
  balances: BalanceView[]
  settlements: SettlementView[]
  /** Every account on the event with what has been posted to it. */
  accounts: AccountView[]
  /** The sum of DEBITS into category accounts, in the event's currency. */
  totalCents: number
  /** The EVENT's currency: what `totalCents`, balances and settlements are in. */
  currency: string
  /**
   * Whether anything in this budget went through a conversion (#59) — a
   * receipt in another currency, or a residual left on `Rounding` by a
   * currency change.
   *
   * It is what lets the screen say, once and as a statement of fact, that the
   * totals are close rather than exact: converted at the rate recorded with
   * each entry, the way a card receipt says "rate at time of purchase". A
   * budget spent entirely in the trip's own currency is exact, and says
   * nothing.
   */
  approximate: boolean
}> {
  const db = useDb()
  const [eventRow] = await db
    .select({ currency: tables.event.currency })
    .from(tables.event)
    .where(eq(tables.event.id, eventId))
    .limit(1)
  if (!eventRow) throw createError({ statusCode: 404, message: 'Event not found' })
  const baseCurrency = eventRow.currency
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

  const lineRows = rows.length
    ? await db
        .select()
        .from(tables.expenseShare)
        .where(inArray(tables.expenseShare.expenseId, rows.map(r => r.expense.id)))
        // `seq`, and nothing else: the lines of an entry are written in ONE
        // insert and therefore share `created_at` to the microsecond (Postgres
        // `now()` is transaction time), and cuid2 ids do not sort by age.
        .orderBy(asc(tables.expenseShare.seq), asc(tables.expenseShare.id))
    : []

  // AFTER the lines, on purpose. A concurrent `addExpense` that creates a new
  // member account and commits between the two reads would otherwise leave a
  // line whose account is not in this map — and the fallback would type it as a
  // category, adding somebody's share to the trip total while its owner
  // vanished from the balances. Reading second makes the map a superset.
  const accounts = await loadEventAccounts(eventId)
  const byAccountId = new Map(accounts.map(a => [a.id, a]))

  // The receipts (#29), in ONE query for the whole budget rather than one per
  // entry — a budget renders every expense it has.
  const receipts = await listReceiptsByExpense(eventId, rows.map(r => r.expense.id))

  const allLines: LedgerLineView[] = lineRows.map((l) => {
    const acc = byAccountId.get(l.accountId)
    return {
      accountId: l.accountId,
      accountName: acc?.name ?? 'Unknown account',
      accountKind: acc?.kind ?? 'category',
      accountEmail: acc?.email ?? null,
      amountCents: l.amountCents,
      amountBaseCents: l.amountBaseCents,
      weight: l.weight === null ? null : trimDecimal(l.weight)
    }
  })
  const linesByExpense = new Map<string, LedgerLineView[]>()
  lineRows.forEach((l, i) => {
    const bucket = linesByExpense.get(l.expenseId)
    if (bucket) bucket.push(allLines[i]!)
    else linesByExpense.set(l.expenseId, [allLines[i]!])
  })

  const expenses: ExpenseView[] = rows.map(({ expense: r, addedByName, addedByEmail }) => {
    const lines = linesByExpense.get(r.id) ?? []
    // The DEBIT into a category account is where this entry's cost landed. An
    // entry with no such line is a transfer between two friends, which is not a
    // cost and has no category; there is no way to write one yet (#28), and the
    // shape rather than a flag is what will keep it out of the total.
    const destination = lines.find(l => l.accountKind === 'category' && l.amountCents > 0)
    return {
      id: r.id,
      title: r.title,
      // `null`, NOT `Uncategorised` (#74 review). An entry with no category
      // line has no category, and naming the default account here filed every
      // transfer under it for any client that groups on this string without
      // also reading `categoryAccountId` beside it. It is a narrowing for
      // Enterprise — `Expense.category` becomes nullable — and it is free
      // inside the re-vendor #270 already holds open.
      category: destination?.accountName ?? null,
      categoryAccountId: destination?.accountId ?? null,
      amountCents: r.amountCents,
      currency: r.currency,
      amountBaseCents: r.amountBaseCents,
      baseCurrency: r.baseCurrency,
      fxRate: trimDecimal(r.fxRate),
      fxRateSource: r.fxRateSource,
      statedAmountCents: r.statedAmountCents,
      statedCurrency: r.statedCurrency,
      splitMode: r.splitMode,
      paidByName: r.paidByName,
      paidByEmail: r.paidByEmail,
      note: r.note,
      createdAt: r.createdAt,
      addedByName,
      addedByEmail: addedByEmail?.toLowerCase() ?? null,
      // What a "share" has always meant: the member DEBIT lines. The payer's
      // credit is a member line too and is excluded by its sign, not by a flag.
      shares: lines
        .filter(l => l.accountKind === 'member' && l.amountCents >= 0)
        .map(l => ({
          name: l.accountName,
          email: l.accountEmail ?? '',
          amountCents: l.amountCents,
          amountBaseCents: l.amountBaseCents,
          weight: l.weight
        })),
      lines,
      receipt: receipts.get(r.id) ?? null
    }
  })

  const balances = computeBalances(allLines)
  return {
    expenses,
    balances,
    settlements: suggestSettlements(balances),
    accounts,
    totalCents: computeTotalCents(allLines),
    currency: baseCurrency,
    // A conversion happened, or a currency change left cents on `Rounding`.
    // Computed from the rows rather than from a flag somebody has to set: an
    // entry recorded in the trip's own currency at rate 1 is exact, and a
    // budget made only of those says nothing about approximation.
    //
    // THE RATE, NOT THE TWO CURRENCY CODES. `currency !== baseCurrency` is what
    // this said first, and it is false on exactly the most approximate budget
    // there is: a trip of EUR receipts moved to EUR, where every figure is a
    // chained conversion of what the payers stated, every code matches, and the
    // residual is zero so no `Rounding` line exists either. Both disjuncts were
    // false and the screen said nothing (#59 review). See
    // `shared/utils/conversion.ts`, which the card reads too.
    approximate: expenses.some(wasConverted)
      || accounts.some(a => a.kind === 'rounding' && a.lineCount > 0)
  }
}

/**
 * What the expense form shows before anything is saved: today's rate into the
 * currency it is about to be recorded in, if one can be had.
 *
 * `into` is the TRIP's currency (#59) and the form passes it, because that is
 * what the expense will be converted into; it falls back to the instance
 * default so a caller with no trip in hand still gets an answer.
 *
 * A SUGGESTION AND NOTHING MORE. `rate: null` is an ordinary answer — the
 * currency is not on the ECB's list, the instance has no outbound network,
 * frankfurter is down — and even a rate that does come back is only a
 * pre-fill: the person who paid knows what they paid, and the write takes
 * either their rate or their out-of-pocket total over this.
 */
export async function quoteExpenseRate(currency: string, into?: string): Promise<{
  currency: string
  baseCurrency: string
  rate: string | null
  asOf: string | null
}> {
  const baseCurrency = normaliseCurrency(into || await instanceBaseCurrency())
  if (!isCurrencyCode(baseCurrency)) {
    throw createError({ statusCode: 422, message: 'A currency is a three-letter code, like CHF or EUR.' })
  }
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
 * Settle the conversion for one expense: which currency it is being recorded
 * against, at what rate, what that makes it worth, and who said so.
 *
 * THREE WAYS IN, in the order they override each other (#59):
 *
 *   targetAmountCents   what the payer was actually out of pocket. Verbatim;
 *                       the rate is derived from it for the record.
 *   fxRate              the rate, typed. Nothing is fetched.
 *   (neither)           frankfurter, once, with a 2.5s ceiling.
 *
 * The first two are the point rather than the edge case: the fetched rate is a
 * mid-market number and a bank charges `price × rate × fee`, so the person
 * reading their statement is the one holding the true figure. Both are recorded
 * as `manual` and neither is ever silently replaced.
 *
 * The outbound fetch happens HERE — before the transaction opens, and only when
 * there is something to convert and nobody has said what it was. An expense in
 * the trip's own currency never leaves the process, which is the ordinary case;
 * neither does one carrying its own rate or total, which is also the whole
 * answer for an instance with no outbound network. When a needed fetch comes
 * back empty the write is refused with a message naming the fields to fill in
 * rather than being recorded at a rate nobody chose.
 */
async function resolveConversion(
  // Only the four money fields, so an EDIT (#27) can hand in the merged figures
  // without pretending to be a whole `AddExpenseInput`. `AddExpenseInput` still
  // satisfies it, so `addExpense` passes itself unchanged.
  input: Pick<AddExpenseInput, 'amountCents' | 'currency' | 'fxRate' | 'targetAmountCents'>,
  eventCurrency: string
): Promise<{
  currency: string
  baseCurrency: string
  fxRate: string
  fxRateSource: FxRateSource
  amountBaseCents: number
  /**
   * What the person said, as they said it — the figure and the currency it was
   * stated in (#59 review). `null` on a `fetched` row, where nobody said
   * anything, and kept beside the derived amount rather than instead of it so a
   * recomputation cannot destroy it.
   */
  statedAmountCents: number | null
  statedCurrency: string | null
}> {
  const baseCurrency = eventCurrency
  const currency = normaliseCurrency(input.currency ?? baseCurrency)
  if (!isCurrencyCode(currency)) {
    throw createError({ statusCode: 422, message: 'A currency is a three-letter code, like CHF or EUR.' })
  }

  const statedRate = input.fxRate !== undefined && input.fxRate !== null && `${input.fxRate}`.trim() !== ''
    ? `${input.fxRate}`.trim()
    : null
  const statedTarget = input.targetAmountCents ?? null
  if (statedRate !== null && statedTarget !== null) {
    throw createError({
      statusCode: 422,
      message: 'Give the rate you were charged OR what you actually paid, not both — they can disagree, and there is no honest way to pick one.'
    })
  }
  if (statedTarget !== null && (!Number.isInteger(statedTarget) || statedTarget <= 0)) {
    throw createError({ statusCode: 422, message: 'What you actually paid must be a positive number of cents' })
  }
  if (statedTarget !== null && statedTarget > MAX_CENTS) {
    throw createError({ statusCode: 422, message: 'That is more money than one expense can hold' })
  }

  // Nothing was converted, so there is nothing for anybody to override. Saying
  // so beats accepting a rate of 1.4 on a CHF receipt of a CHF trip and
  // recording a number the person will never be able to explain.
  if (currency === baseCurrency) {
    if (statedRate !== null && statedRate !== '1') {
      throw createError({
        statusCode: 422,
        message: `This was spent in ${baseCurrency}, which is what this trip settles in — there is no rate to apply.`
      })
    }
    if (statedTarget !== null && statedTarget !== input.amountCents) {
      throw createError({
        statusCode: 422,
        message: `This was spent in ${baseCurrency}, which is what this trip settles in — what was paid is the amount itself.`
      })
    }
    return {
      currency,
      baseCurrency,
      fxRate: '1',
      fxRateSource: 'fetched',
      amountBaseCents: input.amountCents,
      statedAmountCents: null,
      statedCurrency: null
    }
  }

  if (statedTarget !== null) {
    return {
      currency,
      baseCurrency,
      fxRate: deriveRate(input.amountCents, statedTarget),
      fxRateSource: 'manual',
      amountBaseCents: statedTarget,
      statedAmountCents: statedTarget,
      statedCurrency: baseCurrency
    }
  }

  if (statedRate !== null) {
    // A typed RATE is a statement about money too: the person asserted that
    // this receipt cost them this much, and multiplying it out is arithmetic,
    // not a lookup. So the product is recorded as stated — the two manual forms
    // are kept the same way because the question a later reader asks of either
    // is the same one.
    const stated = convertCents(input.amountCents, statedRate)
    return {
      currency,
      baseCurrency,
      fxRate: statedRate,
      fxRateSource: 'manual',
      amountBaseCents: stated,
      statedAmountCents: stated,
      statedCurrency: baseCurrency
    }
  }

  const quote = await fetchFxRate(currency, baseCurrency)
  if (!quote) {
    throw createError({
      statusCode: 422,
      message: `No ${currency} → ${baseCurrency} rate could be fetched just now. Enter the rate yourself, or what you were actually charged, and the expense will be recorded with it.`
    })
  }
  return {
    currency,
    baseCurrency,
    fxRate: quote.rate,
    fxRateSource: 'fetched',
    amountBaseCents: convertCents(input.amountCents, quote.rate),
    statedAmountCents: null,
    statedCurrency: null
  }
}

/**
 * WHETHER THIS ENTRY IS A COST OR A TRANSFER (#28) — the ONE thing a settlement
 * decides differently from an expense, and the reason there is no second write
 * path for one.
 *
 * `category` resolves a category account (`Uncategorised` when nobody picked
 * anything) and posts the cost through it. `transfer` writes no category line
 * at all, so the entry is member-to-member and the trip total — the sum of
 * debits into category accounts — cannot see it.
 *
 * IT IS A PARAMETER, NOT A COLUMN, and that distinction is the whole of the
 * owner's call on this issue. Nothing is stored, nothing can be set wrong on a
 * row, and nothing downstream reads a flag: what is persisted is the SHAPE, and
 * `shared/utils/settlement.ts` is the single rule that reads it back. A stored
 * `kind` could disagree with the lines beside it; this cannot.
 */
export type EntryDestination = 'category' | 'transfer'

/**
 * Record an expense as a balanced journal entry, in one transaction.
 *
 * The order matters. Shares are resolved and the rate settled BEFORE the
 * transaction opens (an outbound HTTP call must never be made with one open);
 * inside it the accounts are found or created, the lines are built, the entry
 * is checked to balance, and only then is anything written. An entry that does
 * not balance is never persisted — the check is the last thing before the
 * insert, not a report afterwards.
 *
 * `destination` is how a SETTLEMENT is written (#28): the same validation, the
 * same conversion, the same event lock, the same `buildEntryLines` /
 * `assertEntryBalances` pair, the same insert — with no category line. The
 * issue asked for one share filled in and no second write path, and this is
 * that, rather than sixty lines of transaction copied into another file to
 * drift away from this one.
 */
export async function addExpense(
  eventId: string,
  input: AddExpenseInput,
  by: ExpenseActor,
  destination: EntryDestination = 'category'
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw createError({ statusCode: 422, message: 'The amount must be a positive number of cents' })
  }
  if (input.amountCents > MAX_CENTS) {
    throw createError({ statusCode: 422, message: 'That is more money than one expense can hold' })
  }
  const splitMode = input.splitMode ?? 'even'
  const resolved = resolveShares(input.amountCents, input.participants, splitMode)
  const [ev] = await useDb()
    .select({ currency: tables.event.currency })
    .from(tables.event)
    .where(eq(tables.event.id, eventId))
    .limit(1)
  if (!ev) throw createError({ statusCode: 404, message: 'Event not found' })
  const {
    currency,
    baseCurrency,
    fxRate,
    fxRateSource,
    amountBaseCents,
    statedAmountCents,
    statedCurrency
  } = await resolveConversion(input, ev.currency)
  const expenseId = createId()
  const db = useDb()

  await db.transaction(async (tx) => {
    // The trip's currency was read (and the rate fetched) OUTSIDE this
    // transaction, because an outbound HTTP call must never be made with one
    // open. Take the row's lock here and re-read it: without this, an expense
    // recorded while a planner is changing the trip's currency lands stamped
    // with the old one and is missed by the recompute that is running beside
    // it — a mis-stamped row produced by a race rather than by the arithmetic.
    //
    // `for update` and not merely a re-read, because `setEventCurrency` takes
    // the same lock: the two operations are then ordered rather than
    // interleaved, which is the half of the window #57 had to leave open on the
    // instance setting and this shape closes.
    const [held] = await tx
      .select({ currency: tables.event.currency })
      .from(tables.event)
      .where(eq(tables.event.id, eventId))
      .for('update')
      .limit(1)
    if (held?.currency !== baseCurrency) {
      throw createError({
        statusCode: 409,
        message: `This trip's currency changed to ${held?.currency} while the expense was being recorded. Try again.`
      })
    }

    const accounts = await ensureEventAccountsWithin(tx, eventId)
    // A transfer has no category, and a caller that named one is confused
    // about what it is writing rather than being helpful. 500, not 422:
    // nothing a person can type reaches this — `recordSettlement` sends
    // neither field.
    if (destination === 'transfer' && (input.accountId != null || input.category != null)) {
      throw createError({ statusCode: 500, message: 'A transfer between two people has no category' })
    }
    const categoryAccountId = destination === 'transfer'
      ? null
      : resolveCategoryAccount(accounts, { accountId: input.accountId, category: input.category }).id
    const rounding = accounts.find(a => a.kind === 'rounding')
    if (!rounding) {
      throw createError({ statusCode: 500, message: `This event has no ${ROUNDING} account` })
    }
    const members = await ensureMemberAccountsWithin(tx, eventId, [
      { name: input.paidByName, email: input.paidByEmail },
      ...resolved.map(r => ({ name: r.name, email: r.email }))
    ])
    const payerAccount = members.get(input.paidByEmail.trim().toLowerCase())
    if (!payerAccount) {
      throw createError({ statusCode: 500, message: 'The payer has no account on this event' })
    }

    const lines = buildEntryLines({
      amountCents: input.amountCents,
      amountBaseCents,
      payerAccountId: payerAccount.id,
      categoryAccountId,
      roundingAccountId: rounding.id,
      shares: resolved.map(share => ({
        accountId: members.get(share.email)!.id,
        amountCents: share.amountCents,
        weight: share.weight
      }))
    })
    assertEntryBalances(lines)

    await tx.insert(tables.expense).values({
      id: expenseId,
      eventId,
      title: input.title,
      amountCents: input.amountCents,
      currency,
      baseCurrency,
      fxRate,
      fxRateSource,
      amountBaseCents,
      statedAmountCents,
      statedCurrency,
      splitMode,
      paidByName: input.paidByName,
      paidByEmail: input.paidByEmail.toLowerCase(),
      note: input.note ?? null,
      createdByUserId: by.userId,
      createdByGuestEmail: null
    })
    await tx.insert(tables.expenseShare).values(lines.map((line, seq) => ({
      id: createId(),
      expenseId,
      eventId,
      accountId: line.accountId,
      // The order `buildEntryLines` put them in, which is the order the entry
      // reads in and the order the person named the split in. Nothing else in
      // the row can carry it: one insert means one `created_at` for all of them.
      seq,
      amountCents: line.amountCents,
      amountBaseCents: line.amountBaseCents,
      weight: line.weight
    })))
  })

  // The recorded expense's id rides along with the budget: the caller that
  // needs the budget ignores it, and the machine API — whose contract answers
  // the ONE expense just recorded — can find it without guessing at ordering.
  return { ...await loadBudget(eventId), expenseId }
}

/**
 * WHAT AN EDIT DOES TO THE CONVERSION (#27) — three branches, and each of them
 * is a decision about the pair of columns #59 added for evidence.
 *
 * `stated_amount_cents`/`stated_currency` are what a PERSON said they were out
 * of pocket, and `fx_rate_source = 'manual'` is the claim that somebody checked
 * this row against a statement. Neither may be invented and neither may be
 * quietly carried onto a figure it was never about.
 *
 *   SOMEBODY SAID WHAT IT COST, or the receipt's currency moved
 *     → settle it afresh through `resolveConversion`, exactly as a new expense
 *       would. A stated rate or total is recorded as `manual` with the evidence
 *       beside it; a changed currency re-fetches (or takes what was typed), and
 *       a fetch that comes back empty is the same 422 naming both fields.
 *
 *   THE MONEY DID NOT MOVE
 *     → the conversion is not touched AT ALL. Correcting a title, a category, a
 *       note or the payer of a row somebody checked leaves it checked, with the
 *       figure they stated still on it. Re-fetching here would silently replace
 *       a verified figure with a mid-market one.
 *
 *   THE AMOUNT MOVED AND NOBODY SAID ANYTHING
 *     → the rate this row was frozen at carries the new amount, which is the
 *       issue's own rule ("an edited expense keeps its original FX rate unless
 *       the currency itself changes") and keeps a payer's bank fee in the
 *       split, because it is inside that effective rate. The stated pair is
 *       CLEARED and the source becomes `fetched`, because both were about a
 *       receipt figure that has just been declared wrong: the honest record is
 *       that this instance multiplied, not that somebody checked. Re-stating it
 *       is one field away — send `fxRate` or `targetAmountCents` in the same
 *       PATCH and the first branch takes it.
 *
 * The alternative to that last one was to REFUSE the edit until the figure was
 * restated. It preserves strictly more evidence, and it was not taken: it
 * leaves no way at all to correct a typo on a row whose receipt is already in
 * the trip's currency but whose settled figure is not (the EUR-receipt-on-an-
 * EUR-trip row #59 leaves behind), since neither override is accepted there.
 */
async function resolveEditConversion(
  row: typeof tables.expense.$inferSelect,
  input: UpdateExpenseInput,
  eventCurrency: string,
  amountCents: number
): Promise<{
  currency: string
  baseCurrency: string
  fxRate: string
  fxRateSource: FxRateSource
  amountBaseCents: number
  statedAmountCents: number | null
  statedCurrency: string | null
}> {
  const currency = normaliseCurrency(input.currency ?? row.currency)
  const stated = input.fxRate !== undefined || input.targetAmountCents !== undefined
  if (stated || currency !== normaliseCurrency(row.currency)) {
    return resolveConversion(
      { amountCents, currency, fxRate: input.fxRate, targetAmountCents: input.targetAmountCents },
      eventCurrency
    )
  }

  if (amountCents === row.amountCents) {
    return {
      currency,
      // Re-stamped from the trip rather than copied from the row. They agree in
      // every reachable state — `setEventCurrency` moves both together — and
      // when they do not, the trip is the one that is right.
      baseCurrency: eventCurrency,
      fxRate: trimDecimal(row.fxRate),
      fxRateSource: row.fxRateSource,
      amountBaseCents: row.amountBaseCents,
      statedAmountCents: row.statedAmountCents,
      statedCurrency: row.statedCurrency
    }
  }

  const fxRate = trimDecimal(row.fxRate)
  return {
    currency,
    baseCurrency: eventCurrency,
    fxRate,
    fxRateSource: 'fetched',
    // `1` for anything recorded in the trip's own currency, so this is the
    // identity it looks like there; a chained or stated rate for everything
    // else, which is what keeps the fee proportional to the corrected receipt.
    amountBaseCents: convertCents(amountCents, fxRate),
    statedAmountCents: null,
    statedCurrency: null
  }
}

/**
 * Correct an expense in place: a new total, a different payer, a fixed title, a
 * re-split (#27). One transaction, and the entry that comes out of it is built
 * by the same `buildEntryLines` / `assertEntryBalances` pair as a new one — so
 * "the shares sum to the total, in both columns" is the same invariant after an
 * edit as before it, asserted before anything is written rather than checked
 * afterwards.
 *
 * NO PER-ROW PERMISSION HERE, on purpose and unlike `removeExpense`. Any
 * participant may correct any expense, which is how a shared ledger among
 * friends actually works — somebody who was there knows the taxi was 88.40 —
 * and what keeps it from being a free-for-all is that it is ATTRIBUTABLE:
 * `created_by_user_id` still names who added it and the audit log names who
 * changed it. The surface gates (`updateExpenseAs…` below) decide who may
 * reach this at all.
 */
export async function updateExpense(eventId: string, expenseId: string, input: UpdateExpenseInput) {
  if (input.amountCents !== undefined) {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw createError({ statusCode: 422, message: 'The amount must be a positive number of cents' })
    }
    if (input.amountCents > MAX_CENTS) {
      throw createError({ statusCode: 422, message: 'That is more money than one expense can hold' })
    }
  }
  // An account is a name AND an address: half a payer would either rename
  // whoever holds the other half or create an account called after nobody.
  if ((input.paidByName === undefined) !== (input.paidByEmail === undefined)) {
    throw createError({ statusCode: 422, message: 'Changing who paid needs both their name and their email' })
  }
  if (input.splitMode !== undefined && input.participants === undefined) {
    throw createError({
      statusCode: 422,
      message: 'Changing how an expense is split needs the split itself — send the participants with the mode'
    })
  }

  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.expense)
    .where(and(eq(tables.expense.id, expenseId), eq(tables.expense.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'Expense not found' })
  const [ev] = await db
    .select({ currency: tables.event.currency })
    .from(tables.event)
    .where(eq(tables.event.id, eventId))
    .limit(1)
  if (!ev) throw createError({ statusCode: 404, message: 'Event not found' })

  const amountCents = input.amountCents ?? row.amountCents
  // Outside the transaction, because this one may make an outbound call.
  const conversion = await resolveEditConversion(row, input, ev.currency, amountCents)
  const seenAt = row.updatedAt.getTime()

  await db.transaction(async (tx) => {
    // The same event lock `addExpense` and `setEventCurrency` take, so all
    // three are ordered against each other rather than interleaved.
    const [held] = await tx
      .select({ currency: tables.event.currency })
      .from(tables.event)
      .where(eq(tables.event.id, eventId))
      .for('update')
      .limit(1)
    if (held?.currency !== conversion.baseCurrency) {
      throw createError({
        statusCode: 409,
        message: `This trip's currency changed to ${held?.currency} while the expense was being edited. Try again.`
      })
    }
    // ...and the row itself may have moved under us while we were deciding
    // (another correction, or the recompute a currency change ran). Everything
    // below is computed from what it said THEN, including the rate, so the
    // honest answer is to send the editor back to look rather than to write a
    // merge nobody asked for. `updated_at` moves on every write to this row
    // (`$onUpdate` in the schema), which is what makes it the fingerprint.
    const [current] = await tx
      .select({ updatedAt: tables.expense.updatedAt })
      .from(tables.expense)
      .where(eq(tables.expense.id, expenseId))
      .limit(1)
    if (!current) throw createError({ statusCode: 404, message: 'Expense not found' })
    if (current.updatedAt.getTime() !== seenAt) {
      throw createError({
        statusCode: 409,
        message: 'This expense changed while you were editing it. Open it again and make the change on what it says now.'
      })
    }

    const accounts = await ensureEventAccountsWithin(tx, eventId)
    const rounding = accounts.find(a => a.kind === 'rounding')
    if (!rounding) {
      throw createError({ statusCode: 500, message: `This event has no ${ROUNDING} account` })
    }
    const byAccountId = new Map(accounts.map(a => [a.id, a]))

    const lineRows = await tx
      .select()
      .from(tables.expenseShare)
      .where(eq(tables.expenseShare.expenseId, expenseId))
      .orderBy(asc(tables.expenseShare.seq), asc(tables.expenseShare.id))

    // The member DEBITS, in the order they were written — which is the order
    // the person named the split in, and the order an edit has to hand back.
    // The payer's credit is a member line too and is excluded by its sign.
    const recorded = lineRows.flatMap((l) => {
      const account = byAccountId.get(l.accountId)
      if (account?.kind !== 'member' || l.amountCents < 0) return []
      return [{
        name: account.name,
        email: account.email ?? '',
        amountCents: l.amountCents,
        weight: l.weight === null ? null : trimDecimal(l.weight)
      }]
    })
    const recordedCategory = lineRows.find(
      l => byAccountId.get(l.accountId)?.kind === 'category' && l.amountCents > 0
    )?.accountId ?? null

    // NO CATEGORY LINE MEANS THIS IS A SETTLEMENT (#28), and an edit may not
    // turn one into something else. Four refusals, because a transfer is a
    // SHAPE — one credit, one debit, no category — and each of these fields
    // breaks a different part of it (#74 review):
    //
    //   category / accountId  would make a payment a cost. The trip total is
    //     the sum of debits into category accounts, so CHF 300 handed over to
    //     clear a debt would be counted as CHF 300 spent on something.
    //   participants          more than one recipient is not a transfer. Three
    //     people would be debited for a payment one person made, every balance
    //     would move, and the shape every reader relies on — `shares` has one
    //     entry, `lines` has two — would stop holding. It is also the condition
    //     `buildEntryLines` needs for a transfer's base column to close against
    //     its own header; see the note there.
    //   splitMode             a payment is not divided, so a mode for it would
    //     record an intention nobody had — and `even` over one person is what
    //     keeps a corrected amount re-derivable (`resplitFromRecord`).
    //   title                 is DERIVED for a transfer (`settlementTitle`), so
    //     accepting one would discard it silently.
    //
    // Everything else works on a transfer — a mistyped amount, a note, the
    // payer, the recipient — so this refuses the fields that change what the
    // entry IS rather than refusing the edit.
    if (recordedCategory === null) {
      if (input.accountId !== undefined || input.category !== undefined) {
        throw createError({
          statusCode: 422,
          message: 'This entry is a payment between two people, not a cost, so it has no category.'
        })
      }
      if (input.participants !== undefined && input.participants.length !== 1) {
        throw createError({
          statusCode: 422,
          message: 'A payment goes to ONE person. Send only the person who was paid, or remove it and record it again.'
        })
      }
      if (input.splitMode !== undefined) {
        throw createError({
          statusCode: 422,
          message: 'A payment between two people is not split, so it has no split mode.'
        })
      }
      if (input.title !== undefined) {
        throw createError({
          statusCode: 422,
          message: 'A payment is titled after the two people in it, so its title is not set by hand.'
        })
      }
    }

    const splitMode = input.splitMode ?? row.splitMode
    const resolved = input.participants
      ? resolveShares(amountCents, input.participants, splitMode)
      : resplitFromRecord({
          splitMode: row.splitMode,
          amountCents,
          previousAmountCents: row.amountCents,
          shares: recorded
        })

    // Absent means unchanged, and this is the one place where the difference
    // bites: `resolveCategoryAccount` with neither field answers `Uncategorised`,
    // so calling it unconditionally would move every edited expense out of its
    // category for saying nothing about categories.
    const destination = input.accountId !== undefined || input.category !== undefined
      ? resolveCategoryAccount(accounts, { accountId: input.accountId, category: input.category }).id
      : recordedCategory

    const paidByName = input.paidByName ?? row.paidByName
    const paidByEmail = (input.paidByEmail ?? row.paidByEmail).trim().toLowerCase()
    // The shape a transfer must still have after the edit, asserted before
    // anything is written rather than hoped for. The refusals above make it
    // unreachable from a request, which is exactly why it is a 500: reaching it
    // means this file has a bug, not that the caller sent something wrong.
    if (recordedCategory === null && resolved.length !== 1) {
      throw createError({
        statusCode: 500,
        message: 'A payment between two people has exactly one share. Nothing was changed.'
      })
    }
    // …and its title is DERIVED, so correcting the payer or the recipient
    // renames the entry with them. Frozen, it was a lie the moment either
    // moved — and `/api/v1` and the audit log read `title` where the card
    // reads the fields (#74 review).
    const title = recordedCategory === null
      ? settlementTitle(paidByName, resolved[0]!.name)
      : (input.title ?? row.title)
    const members = await ensureMemberAccountsWithin(tx, eventId, [
      { name: paidByName, email: paidByEmail },
      ...resolved.map(r => ({ name: r.name, email: r.email }))
    ])
    const payerAccount = members.get(paidByEmail)
    if (!payerAccount) {
      throw createError({ statusCode: 500, message: 'The payer has no account on this event' })
    }

    const lines = buildEntryLines({
      amountCents,
      amountBaseCents: conversion.amountBaseCents,
      payerAccountId: payerAccount.id,
      categoryAccountId: destination,
      roundingAccountId: rounding.id,
      // No `amountBaseCents` per share, so the group apportionment runs — the
      // WRITE path's rule and not #59's. The per-person base figures are being
      // re-derived from a total here, not re-expressed at a new rate, so
      // converting each on its own would invent a cent of liability rather than
      // discover one, and the residual is structurally zero again.
      shares: resolved.map(share => ({
        accountId: members.get(share.email)!.id,
        amountCents: share.amountCents,
        weight: share.weight
      }))
    })
    assertEntryBalances(lines)

    await tx.update(tables.expense).set({
      title,
      amountCents,
      currency: conversion.currency,
      baseCurrency: conversion.baseCurrency,
      fxRate: conversion.fxRate,
      fxRateSource: conversion.fxRateSource,
      amountBaseCents: conversion.amountBaseCents,
      statedAmountCents: conversion.statedAmountCents,
      statedCurrency: conversion.statedCurrency,
      splitMode,
      paidByName,
      paidByEmail,
      // `null` is a value here and `undefined` is not: sending `note: null`
      // clears it, leaving it out keeps it.
      note: input.note !== undefined ? input.note : row.note
      // `createdByUserId` and `createdAt` are deliberately absent: they say who
      // ADDED this and when, and an edit does not change either. Who edited it
      // is the audit log's answer.
    }).where(eq(tables.expense.id, expenseId))

    await tx.delete(tables.expenseShare).where(eq(tables.expenseShare.expenseId, expenseId))
    await tx.insert(tables.expenseShare).values(lines.map((line, seq) => ({
      id: createId(),
      expenseId,
      eventId,
      accountId: line.accountId,
      seq,
      amountCents: line.amountCents,
      amountBaseCents: line.amountBaseCents,
      weight: line.weight
    })))
  })

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

/** Correct an expense as a planner (owner/co-planner only). */
export async function updateExpenseAsPlanner(
  userId: string,
  slug: string,
  expenseId: string,
  input: UpdateExpenseInput
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return updateExpense(ev.id, expenseId, input)
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
 *
 * EXPORTED so `server/domain/settlements.ts` can use THIS function rather than
 * a second one shaped like it (#28). Recording a payment is a money write on
 * the same ledger, and two gates answering one verb is how a role restriction
 * stops meaning anything — #48 shipped exactly that bug once, with `logistics`
 * 403'd on one surface and 200'd on the other.
 */
export async function assertMayWriteExpenses(slug: string, actor: ParticipantActor) {
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

/**
 * Correct an expense as a signed-in PARTICIPANT — ANY expense on the trip,
 * including one somebody else recorded (#27).
 *
 * That is wider than `removeExpenseAsParticipant`, which is the recorder, the
 * payer or a planner, and the asymmetry is the point rather than an oversight:
 * a friend who was there can fix a figure, and a wrong figure fixed by the
 * wrong person is still fixed, while a wrong deletion cannot be undone by
 * anybody. The gate is the same one `addExpenseAsParticipant` uses, so nothing
 * is widened about WHO may touch this trip's money — and no `by` is threaded
 * through, because there is no per-row rule for it to decide.
 */
export async function updateExpenseAsParticipant(
  actor: ParticipantActor,
  slug: string,
  expenseId: string,
  input: UpdateExpenseInput
) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  return updateExpense(ev.id, expenseId, input)
}

/* ----------------------------- the receipt (#29) ---------------------------- */

/**
 * ATTACHING A RECEIPT IS AN EXPENSE WRITE, and that is the whole of why these
 * four wrappers are in this file rather than in `server/domain/media.ts`.
 *
 * The issue draws the line across the middle of one action: UPLOADING a photo
 * stays a guest capability — anyone holding the invite link may already add to
 * the gallery and nothing here narrows that — while PINNING one to an expense
 * is a statement about the money and needs the account gate #48 put on every
 * other expense write. So the gate is `assertMayWriteExpenses`, the same
 * function `addExpenseAsParticipant` and `updateExpenseAsParticipant` use, and
 * `pinReceipt` (which owns the pin, and the rule about which media may be one)
 * runs behind it.
 *
 * Wider than DELETING an expense, and exactly as wide as correcting one: any
 * writer may pin a receipt to any entry on the trip. A receipt on the wrong
 * expense is fixed by moving it; there is nothing here that cannot be undone.
 *
 * They answer the whole budget, like every other write on these surfaces, so
 * the card re-renders from one response instead of refetching.
 */
export async function attachReceiptAsParticipant(
  actor: ParticipantActor,
  slug: string,
  expenseId: string,
  mediaId: string
) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  await pinReceipt(ev.id, expenseId, mediaId)
  return loadBudget(ev.id)
}

export async function detachReceiptAsParticipant(actor: ParticipantActor, slug: string, expenseId: string) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  await unpinReceipt(ev.id, expenseId)
  return loadBudget(ev.id)
}

/**
 * THE UPLOAD HALF OF THE SHORTCUT (#29): register a photo a signed-in
 * participant is about to PUT to the object store, so the next call can pin it.
 *
 * It lives here, beside the pin, because its GATE is the pin's gate. The photo
 * itself is an ordinary gallery photo — it lands where every other one does,
 * everybody on the trip sees it, and deleting the expense later leaves it
 * exactly where it was. What the account buys is nothing about the gallery: it
 * is that the same action can go on to say this photograph is the receipt for
 * that 84 francs, which is an expense write.
 *
 * NOTHING IS NARROWED BY IT. `/api/invites/{token}/media/presign` is untouched
 * and anyone holding the link may still add to the gallery with no account at
 * all; this is a second door for somebody who already has one, not a lock on
 * the first.
 *
 * The MIME and size policy is `registerMediaUpload`'s, unchanged: `image/*` up
 * to 25 MB, 422 and 413 respectively.
 */
export async function addReceiptPhotoAsParticipant(
  actor: ParticipantActor,
  slug: string,
  input: { fileName: string, mimeType: string, sizeBytes: number }
) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  return registerMediaUpload(ev.id, {
    // Spelled out rather than spread: `photo` is the type, not a default an
    // input could ever shadow.
    type: 'photo',
    fileName: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes
  }, { userId: actor.id })
}

/**
 * Step 2 of that upload: the bytes are in the bucket, mark the row `ready`.
 * Only the row this account registered — a pending id is not a capability.
 */
export async function confirmReceiptPhotoAsParticipant(
  actor: ParticipantActor,
  slug: string,
  mediaId: string,
  input: { caption?: string | null, takenAt?: string | null }
) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  return confirmMediaUpload(ev.id, mediaId, input, { requireUploadedByUserId: actor.id })
}

/** The same pair on the host surface, where a planner reads the same card. */
export async function attachReceiptAsPlanner(userId: string, slug: string, expenseId: string, mediaId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await pinReceipt(ev.id, expenseId, mediaId)
  return loadBudget(ev.id)
}

export async function detachReceiptAsPlanner(userId: string, slug: string, expenseId: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await unpinReceipt(ev.id, expenseId)
  return loadBudget(ev.id)
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
