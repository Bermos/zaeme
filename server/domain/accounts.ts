import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertEventOpenToGuests, assertParticipant, assertPlanner, loadEventBySlug, type ParticipantRole } from './permissions'

/**
 * The chart of accounts for one event (#61).
 *
 * Double-entry needs somewhere for each side of a transaction to land, and this
 * file is the only place accounts are created, found or removed. Three kinds and
 * no more: a `member` per person, a `category` per kind of cost, and one
 * `rounding` account per event for the cents that converting a split leaves
 * over.
 *
 * THE POINT OF `Uncategorised`. It is seeded on every event and it is the
 * DEFAULT DESTINATION, so a group that does not care about categories never
 * meets the concept — the picker is not shown until they ask for it — and every
 * line still posts somewhere real. That is what lets `account_id` on a line be
 * NOT NULL, which is the whole design: "nullable when not applicable" is where
 * the `currency` bug lived before #25, and re-inventing that here would be
 * absurd in the issue whose premise is not re-inventing things.
 */

/** Seeded on every event, from the enum `events_expense.category` used to be. */
export const SEEDED_CATEGORIES = ['Travel', 'Accommodation', 'Food', 'Tickets'] as const

/** The default destination. `isSystem`; never deletable. */
export const UNCATEGORISED = 'Uncategorised'

/** Where the conversion residual goes. One per event, `isSystem`. */
export const ROUNDING = 'Rounding'

/**
 * What the old `events_expense.category` enum meant, in account names. A caller
 * that still sends `category: "food"` — every Enterprise client generated from
 * the contract before this change — resolves to the `Food` account, and `other`
 * resolves to `Uncategorised`, which is what `other` always was.
 */
const LEGACY_CATEGORY_NAMES: Record<string, string> = {
  travel: 'Travel',
  accommodation: 'Accommodation',
  food: 'Food',
  tickets: 'Tickets',
  other: UNCATEGORISED
}

export type AccountKind = 'member' | 'category' | 'rounding'

export interface AccountRow {
  id: string
  eventId: string
  kind: AccountKind
  name: string
  email: string | null
  isSystem: boolean
}

/** An account with what has been posted to it, in BASE cents. */
export interface AccountView extends Omit<AccountRow, 'eventId'> {
  /** Sum of DEBITS. On a category account this is what it cost. */
  debitCents: number
  /** Sum of CREDITS, as a positive number. */
  creditCents: number
  /** `creditCents - debitCents`: positive means the account is owed. */
  netCents: number
  /** How many lines have been posted to it — what "holds lines" means. */
  lineCount: number
}

/**
 * The one method set the helpers below need, so they work identically inside a
 * `db.transaction(tx => …)` and outside one. Naming the methods rather than the
 * transaction type is deliberate: drizzle's transaction generic is internal and
 * changes shape between minor versions.
 */
type DbLike = Pick<ReturnType<typeof useDb>, 'select' | 'insert' | 'update' | 'delete'>

function accountRow(r: typeof tables.account.$inferSelect): AccountRow {
  return { id: r.id, eventId: r.eventId, kind: r.kind, name: r.name, email: r.email, isSystem: r.isSystem }
}

/** Every account on an event, categories first, in a stable order. */
export async function listAccountsWithin(db: DbLike, eventId: string): Promise<AccountRow[]> {
  const rows = await db
    .select()
    .from(tables.account)
    .where(eq(tables.account.eventId, eventId))
    .orderBy(asc(tables.account.kind), asc(tables.account.name))
  return rows.map(accountRow)
}

/**
 * Make sure this event has its seeded category accounts and its rounding
 * account, and answer the full list.
 *
 * Lazy rather than done at event creation, because events are created down four
 * different paths (the host form, `/api/v1/events`, `POST /api/v1/concerts/publish`,
 * a series occurrence) and an account that only exists on three of them is worse
 * than none. Seeding here means the ledger is complete the first time anybody
 * looks at the budget, whichever path made the event — and the insert is
 * `on conflict do nothing` against the unique indexes, so concurrent first
 * readers cannot produce two `Food`s.
 */
export async function ensureEventAccountsWithin(db: DbLike, eventId: string): Promise<AccountRow[]> {
  const existing = await listAccountsWithin(db, eventId)
  const haveCategory = new Set(existing.filter(a => a.kind === 'category').map(a => a.name.toLowerCase()))
  const haveRounding = existing.some(a => a.kind === 'rounding')

  // The four named categories are a STARTING POINT and are seeded only for an
  // event that has no chart at all. Re-adding them on every read would make
  // removing one impossible — delete `Tickets`, and the next look at the budget
  // hands it back. What every event must always have is the two the ledger
  // depends on: a default destination, so no line is ever nullable, and a home
  // for the residual. Those two are `isSystem` and cannot be removed anyway.
  const wanted = existing.length === 0 ? [...SEEDED_CATEGORIES, UNCATEGORISED] : [UNCATEGORISED]

  const missing: Array<typeof tables.account.$inferInsert> = []
  for (const name of wanted) {
    if (!haveCategory.has(name.toLowerCase())) {
      missing.push({ id: createId(), eventId, kind: 'category', name, email: null, isSystem: name === UNCATEGORISED })
    }
  }
  if (!haveRounding) {
    missing.push({ id: createId(), eventId, kind: 'rounding', name: ROUNDING, email: null, isSystem: true })
  }
  if (!missing.length) return existing

  await db.insert(tables.account).values(missing).onConflictDoNothing()
  return listAccountsWithin(db, eventId)
}

/** `ensureEventAccountsWithin` on the ordinary client. */
export function ensureEventAccounts(eventId: string): Promise<AccountRow[]> {
  return ensureEventAccountsWithin(useDb(), eventId)
}

/**
 * Get-or-create a member account per person, keyed on the lowercased email that
 * is the identity everywhere else in this domain.
 *
 * The NAME is refreshed when it differs from what is stored: an account is one
 * person, so correcting "Ana Müler" to "Ana Müller" ought to fix every line she
 * is on rather than only the ones recorded afterwards. That is the difference
 * between a name repeated on every row (what the lines used to carry) and an
 * account that has one.
 */
export async function ensureMemberAccountsWithin(
  db: DbLike,
  eventId: string,
  people: Array<{ name: string, email: string }>
): Promise<Map<string, AccountRow>> {
  const wanted = new Map<string, string>()
  for (const p of people) wanted.set(p.email.trim().toLowerCase(), p.name)
  const emails = [...wanted.keys()]
  if (!emails.length) return new Map()

  const found = emails.length
    ? await db
        .select()
        .from(tables.account)
        .where(and(
          eq(tables.account.eventId, eventId),
          eq(tables.account.kind, 'member'),
          inArray(tables.account.email, emails)
        ))
    : []

  const byEmail = new Map<string, AccountRow>()
  for (const r of found) byEmail.set(r.email!, accountRow(r))

  const missing = emails.filter(e => !byEmail.has(e))
  if (missing.length) {
    await db
      .insert(tables.account)
      .values(missing.map(email => ({
        id: createId(),
        eventId,
        kind: 'member' as const,
        name: wanted.get(email)!,
        email,
        isSystem: false
      })))
      .onConflictDoNothing()
    const again = await db
      .select()
      .from(tables.account)
      .where(and(
        eq(tables.account.eventId, eventId),
        eq(tables.account.kind, 'member'),
        inArray(tables.account.email, missing)
      ))
    for (const r of again) byEmail.set(r.email!, accountRow(r))
  }

  for (const [email, name] of wanted) {
    const acc = byEmail.get(email)
    if (acc && name && acc.name !== name) {
      await db.update(tables.account).set({ name }).where(eq(tables.account.id, acc.id))
      acc.name = name
    }
  }
  return byEmail
}

/**
 * Where this entry's cost lands. `accountId` names a category account outright;
 * `category` names one by name, case-insensitively, which is also how the old
 * enum keeps working. Neither given is the ordinary case and lands in
 * `Uncategorised` — the answer that lets the UI never ask.
 */
export function resolveCategoryAccount(
  accounts: AccountRow[],
  ref: { accountId?: string | null, category?: string | null }
): AccountRow {
  const categories = accounts.filter(a => a.kind === 'category')
  const fallback = categories.find(a => a.name === UNCATEGORISED)
  if (!fallback) {
    throw createError({ statusCode: 500, message: 'This event has no Uncategorised account' })
  }

  if (ref.accountId) {
    const picked = categories.find(a => a.id === ref.accountId)
    if (!picked) {
      throw createError({ statusCode: 422, message: 'That is not a category account on this event' })
    }
    return picked
  }

  const asked = (ref.category ?? '').trim()
  if (!asked) return fallback

  const canonical = LEGACY_CATEGORY_NAMES[asked.toLowerCase()] ?? asked
  const picked = categories.find(a => a.name.toLowerCase() === canonical.toLowerCase())
  if (!picked) {
    throw createError({
      statusCode: 422,
      message: `This event has no category called "${asked}". Add it first, or leave the category out and it lands in ${UNCATEGORISED}.`
    })
  }
  return picked
}

/**
 * Every account on the event with what has been posted to it — ONE grouped
 * query, which is what makes "what did accommodation cost" a sum over one
 * account rather than a filter on a string column.
 *
 * The `left join` is load-bearing: a category nobody has used yet is still an
 * account, and the picker has to be able to offer it.
 */
export async function loadEventAccounts(eventId: string): Promise<AccountView[]> {
  const db = useDb()
  await ensureEventAccountsWithin(db, eventId)
  const rows = await db.execute<{
    id: string
    kind: AccountKind
    name: string
    email: string | null
    is_system: boolean
    debit_cents: number
    credit_cents: number
    line_count: number
  }>(sql`
    select a.id, a.kind, a.name, a.email, a.is_system,
           coalesce(sum(case when l.amount_base_cents > 0 then l.amount_base_cents else 0 end), 0)::int as debit_cents,
           coalesce(sum(case when l.amount_base_cents < 0 then -l.amount_base_cents else 0 end), 0)::int as credit_cents,
           count(l.id)::int as line_count
      from events_account a
      left join events_expense_share l on l.account_id = a.id
     where a.event_id = ${eventId}
     group by a.id
     order by a.kind asc, a.name asc
  `)
  return rows.rows.map(r => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    email: r.email,
    isSystem: r.is_system,
    debitCents: r.debit_cents,
    creditCents: r.credit_cents,
    netCents: r.credit_cents - r.debit_cents,
    lineCount: r.line_count
  }))
}

/* --------------------------- participant-scoped ---------------------------- */

/**
 * Who may shape the chart of accounts: the same set that may record an expense.
 * Adding "Ski pass" while entering the ski pass is the point, and a gate that
 * disagreed with the expense gate about one verb is how a role restriction
 * stops meaning anything (#48 shipped exactly that bug once).
 */
const ACCOUNT_WRITERS: readonly ParticipantRole[] = ['participant', 'owner', 'co_planner']

async function assertMayShapeAccounts(slug: string, actor: { id: string }) {
  const ev = await loadEventBySlug(slug)
  assertEventOpenToGuests(ev)
  const role = await assertParticipant(ev.id, actor.id)
  if (!ACCOUNT_WRITERS.includes(role)) {
    throw createError({ statusCode: 403, message: 'Your role on this event does not cover the budget' })
  }
  return ev
}

/** The event's accounts, with their totals, for a participant. */
export async function loadAccountsAsParticipant(actor: { id: string }, slug: string) {
  const ev = await assertMayShapeAccounts(slug, actor)
  return loadEventAccounts(ev.id)
}

const MAX_CATEGORY_NAME = 60

/** Add a category account to this event. Names are unique per event. */
export async function addCategoryAccountAsParticipant(actor: { id: string }, slug: string, name: string) {
  const ev = await assertMayShapeAccounts(slug, actor)
  return addCategoryAccount(ev.id, name)
}

/** Add a category account to an event. The gates above decide who may. */
async function addCategoryAccount(eventId: string, name: string) {
  const clean = name.trim().replace(/\s+/g, ' ')
  if (!clean || clean.length > MAX_CATEGORY_NAME) {
    throw createError({ statusCode: 422, message: `A category name is 1 to ${MAX_CATEGORY_NAME} characters` })
  }
  const db = useDb()
  const accounts = await ensureEventAccountsWithin(db, eventId)
  if (accounts.some(a => a.kind === 'category' && a.name.toLowerCase() === clean.toLowerCase())) {
    throw createError({ statusCode: 409, message: `This event already has a category called "${clean}"` })
  }
  await db.insert(tables.account).values({
    id: createId(),
    eventId,
    kind: 'category',
    name: clean,
    email: null,
    isSystem: false
  })
  return loadEventAccounts(eventId)
}

/**
 * Remove a category account.
 *
 * Two refusals, and they are different refusals on purpose. A SYSTEM account —
 * `Uncategorised`, `Rounding` — is never removable, because every line needs a
 * destination and the residual needs a home. Any other category is removable
 * only WHILE IT HOLDS NO LINES: deleting an account that money has been posted
 * to would either orphan the lines or silently move history somewhere it never
 * was, and neither is something a budget should do quietly.
 */
export async function removeAccountAsParticipant(actor: { id: string }, slug: string, accountId: string) {
  const ev = await assertMayShapeAccounts(slug, actor)
  return removeAccount(ev.id, accountId)
}

/** Remove a category account from an event. The gates above decide who may. */
async function removeAccount(eventId: string, accountId: string) {
  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.account)
    .where(and(eq(tables.account.id, accountId), eq(tables.account.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'No such account on this event' })
  if (row.kind !== 'category') {
    throw createError({ statusCode: 422, message: 'Only category accounts can be removed' })
  }

  const [held] = await db
    .select({ lines: sql<number>`count(*)::int` })
    .from(tables.expenseShare)
    .where(eq(tables.expenseShare.accountId, accountId))
  if ((held?.lines ?? 0) > 0) {
    throw createError({
      statusCode: 409,
      message: `"${row.name}" still has expenses posted to it, so it cannot be removed`
    })
  }
  if (row.isSystem) {
    throw createError({ statusCode: 422, message: `"${row.name}" is part of every budget and cannot be removed` })
  }

  await db.delete(tables.account).where(eq(tables.account.id, accountId))
  return loadEventAccounts(eventId)
}

/* ----------------------------- planner-scoped ------------------------------ */

/**
 * The same three operations on the host surface, gated the way the host
 * surface's expense writes are: `assertPlanner` with `owner`/`co_planner`, and
 * no lifecycle check — a planner shaping the budget of a DRAFT trip is exactly
 * what `/host` is for, and `addExpenseAsPlanner` already takes that view.
 *
 * Two surfaces answering one verb have to agree about WHO, or a role
 * restriction stops meaning anything. They do: `owner` and `co_planner` may act
 * on both, `logistics` on neither, and the account surface additionally lets an
 * ordinary participant of a live event add the category they are recording into.
 */
async function assertMayPlanAccounts(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return ev
}

/** The event's accounts with their totals, for a planner. */
export async function loadAccountsAsPlanner(userId: string, slug: string) {
  const ev = await assertMayPlanAccounts(userId, slug)
  return loadEventAccounts(ev.id)
}

/** Add a category account as a planner. */
export async function addCategoryAccountAsPlanner(userId: string, slug: string, name: string) {
  const ev = await assertMayPlanAccounts(userId, slug)
  return addCategoryAccount(ev.id, name)
}

/** Remove a category account as a planner. */
export async function removeAccountAsPlanner(userId: string, slug: string, accountId: string) {
  const ev = await assertMayPlanAccounts(userId, slug)
  return removeAccount(ev.id, accountId)
}
