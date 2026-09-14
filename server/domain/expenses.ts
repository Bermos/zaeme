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
 */

export type ExpenseCategory = 'travel' | 'accommodation' | 'food' | 'tickets' | 'other'

export interface ExpenseParticipantInput {
  name: string
  email: string
  /** Explicit share in cents; omit for an even split of the remainder. */
  amountCents?: number
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
  shares: Array<{ name: string, email: string, amountCents: number, amountBaseCents: number }>
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
 * Resolve an expense's participant list into materialised shares: explicit
 * amounts are honoured, the rest of the total is split evenly across the
 * participants without one. Throws 422 when the explicit amounts alone
 * overshoot the total or leave nothing valid to distribute.
 */
export function resolveShares(
  amountCents: number,
  participants: ExpenseParticipantInput[]
): Array<{ name: string, email: string, amountCents: number }> {
  const seen = new Set<string>()
  const cleaned = participants
    .map(p => ({ name: p.name, email: p.email.toLowerCase(), amountCents: p.amountCents }))
    .filter((p) => {
      if (seen.has(p.email)) return false
      seen.add(p.email)
      return true
    })
  if (cleaned.length === 0) {
    throw createError({ statusCode: 422, message: 'An expense needs at least one participant' })
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
    amountCents: p.amountCents !== undefined ? p.amountCents : evenShares[flexIndex++]!
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
 * `numeric(20, 10)` comes back from Postgres padded to its scale —
 * `'0.9412000000'` — which is the same number and a worse thing to show a
 * person or hand a client. Trailing zeros off, decimal point with them.
 */
function trimRate(stored: string): string {
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
    fxRate: trimRate(r.fxRate),
    paidByName: r.paidByName,
    paidByEmail: r.paidByEmail,
    note: r.note,
    createdAt: r.createdAt,
    addedByName,
    addedByEmail: addedByEmail?.toLowerCase() ?? null,
    shares: shares
      .filter(s => s.expenseId === r.id)
      .map(s => ({ name: s.name, email: s.email, amountCents: s.amountCents, amountBaseCents: s.amountBaseCents }))
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
  const resolved = resolveShares(input.amountCents, input.participants)
  const { currency, baseCurrency, fxRate, amountBaseCents } = await resolveConversion(input)
  // Apportioned as a group against the CONVERTED TOTAL, so the base shares add
  // up to it exactly — the same guarantee `splitEvenlyCents` gives in the
  // currency the money was actually spent in.
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
      amountBaseCents: baseShares[i]!
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
