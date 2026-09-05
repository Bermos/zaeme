import { and, asc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'

/**
 * The trip budget: expenses someone fronted, split across participants, and
 * the resulting who-owes-whom. Money is integer cents throughout (no float
 * money); shares are materialised at write time so balances are a plain sum.
 * Identity is the same name+email pair RSVPs use.
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
  amountCents: number
  currency?: string
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
  amountCents: number
  currency: string
  paidByName: string
  paidByEmail: string
  note: string | null
  createdAt: Date
  shares: Array<{ name: string, email: string, amountCents: number }>
}

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

/** Per-person balances (paid − owed) across a list of expenses. */
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
    touch(exp.paidByName, exp.paidByEmail.toLowerCase()).paidCents += exp.amountCents
    for (const share of exp.shares) {
      touch(share.name, share.email.toLowerCase()).owedCents += share.amountCents
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

/* --------------------------------- reads ---------------------------------- */

/** All expenses with their shares, plus balances and a settlement plan. */
export async function loadBudget(eventId: string): Promise<{
  expenses: ExpenseView[]
  balances: BalanceView[]
  settlements: SettlementView[]
  totalCents: number
  currency: string
}> {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.expense)
    .where(eq(tables.expense.eventId, eventId))
    .orderBy(asc(tables.expense.createdAt))

  const shares = rows.length
    ? await db
        .select()
        .from(tables.expenseShare)
        .where(inArray(tables.expenseShare.expenseId, rows.map(r => r.id)))
    : []

  const expenses: ExpenseView[] = rows.map(r => ({
    id: r.id,
    title: r.title,
    category: r.category as ExpenseCategory,
    amountCents: r.amountCents,
    currency: r.currency,
    paidByName: r.paidByName,
    paidByEmail: r.paidByEmail,
    note: r.note,
    createdAt: r.createdAt,
    shares: shares
      .filter(s => s.expenseId === r.id)
      .map(s => ({ name: s.name, email: s.email, amountCents: s.amountCents }))
  }))

  const balances = computeBalances(expenses)
  return {
    expenses,
    balances,
    settlements: suggestSettlements(balances),
    totalCents: expenses.reduce((sum, e) => sum + e.amountCents, 0),
    currency: expenses[0]?.currency ?? 'CHF'
  }
}

/* --------------------------------- writes --------------------------------- */

export interface ExpenseActor {
  /** A planner's user id (host side) … */
  userId?: string
  /** … or a guest's email (guest side, via their invite token). */
  guestEmail?: string
}

/** Record an expense with materialised shares, in one transaction. */
export async function addExpense(eventId: string, input: AddExpenseInput, by: ExpenseActor) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw createError({ statusCode: 422, message: 'The amount must be a positive number of cents' })
  }
  const resolved = resolveShares(input.amountCents, input.participants)
  const expenseId = createId()
  const db = useDb()

  await db.transaction(async (tx) => {
    await tx.insert(tables.expense).values({
      id: expenseId,
      eventId,
      title: input.title,
      category: input.category ?? 'other',
      amountCents: input.amountCents,
      currency: (input.currency ?? 'CHF').toUpperCase(),
      paidByName: input.paidByName,
      paidByEmail: input.paidByEmail.toLowerCase(),
      note: input.note ?? null,
      createdByUserId: by.userId ?? null,
      createdByGuestEmail: by.guestEmail?.toLowerCase() ?? null
    })
    await tx.insert(tables.expenseShare).values(resolved.map(share => ({
      id: createId(),
      expenseId,
      eventId,
      name: share.name,
      email: share.email,
      amountCents: share.amountCents
    })))
  })

  return loadBudget(eventId)
}

/**
 * Remove an expense — the person who recorded it (by email), or a planner.
 * Its shares cascade away.
 */
export async function removeExpense(
  eventId: string,
  expenseId: string,
  by: { email?: string, asPlanner?: boolean }
) {
  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.expense)
    .where(and(eq(tables.expense.id, expenseId), eq(tables.expense.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'Expense not found' })

  const isRecorder = !!by.email
    && (row.createdByGuestEmail === by.email.toLowerCase() || row.paidByEmail === by.email.toLowerCase())
  if (!isRecorder && !by.asPlanner) {
    throw createError({ statusCode: 403, message: 'Only the person who recorded this expense can remove it' })
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
