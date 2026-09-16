import { and, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import {
  addExpense,
  assertMayWriteExpenses,
  type ExpenseActor,
  loadBudget,
  type ParticipantActor
} from './expenses'

/**
 * SETTLING UP (#28): saying that a debt the plan suggested has actually been
 * paid, so it leaves the balances instead of being suggested again three weeks
 * after somebody handed over the cash.
 *
 * A SETTLEMENT IS A LEDGER ENTRY, NOT A SECOND TABLE. The issue was originally
 * cut with an `events_settlement` table and its own balance arithmetic, and
 * then with a `kind: 'expense' | 'settlement'` column on `events_expense`; the
 * owner's question — "since the settling payments are also just ledger entries
 * (they are, right??)" — was the right one, and #61 made it true. A payment is
 * an entry paid by the person transferring and split 100% to the person
 * receiving:
 *
 *     Ana pays Matthew 300
 *       credit  member:Ana      300     ← she handed it over
 *       debit   member:Matthew  300     ← he received it
 *
 * Against a prior debt of Ana −300 / Matthew +300 both land on zero, using the
 * split machinery that already exists. No new table, no second balance path, no
 * "subtract settlements" branch in `computeBalances`, and — because it touches
 * NO CATEGORY ACCOUNT — no flag is needed to keep it out of the trip total,
 * which is the sum of debits into category accounts. The shape is the
 * discriminator; `shared/utils/settlement.ts` is the one rule that reads it.
 *
 * SO THIS FILE IS A WRITE AND A DELETE AND ALMOST NOTHING ELSE. Every figure it
 * produces is produced by `addExpense` — the same amount validation, the same
 * conversion (`resolveConversion`, so a payment made in another currency is
 * recorded with its rate, its target currency and its target amount like any
 * other entry), the same event lock, the same `buildEntryLines` /
 * `assertEntryBalances` pair, the same insert. `apportionCents` stays the
 * single rounding path; there is no second one here to get wrong.
 *
 * WHAT A PARTIAL PAYMENT MEANS: exactly what the arithmetic says. Ana owes 300
 * and hands over 100, so she is credited 100 and Matthew debited 100; she is
 * left at −200, he at +200, and the plan asks for 200 next time. Nothing
 * special happens, because nothing special needs to: there is no "is this debt
 * closed" state anywhere to get out of step with the money.
 *
 * WHAT AN OVERPAYMENT MEANS: the same thing, in the other direction. Ana owes
 * 300 and sends 400 — she rounded up, or paid Matthew for something else — and
 * the ledger then says Matthew owes her 100, which is true, and the plan
 * suggests he send it back. That is not refused. A refusal would be this
 * program telling two friends what they may hand each other, it would make a
 * legitimate "here, take the whole 500 and we'll sort the rest later"
 * impossible, and the state it would protect is one the next expense would
 * create anyway.
 *
 * NO LOCK-OUT, FOLLOWING #59. Nothing here refuses an edit, a deletion or a
 * currency change because a settlement exists: a settlement is an entry like
 * any other, so `setEventCurrency` re-expresses it with the rest and the nets
 * still clear. Doing it halfway through settling is awkward and is fixed by
 * peer pressure, not by an inflexibility of this program.
 */

export interface RecordSettlementInput {
  /** Who handed the money over — the debtor, normally. */
  fromName: string
  fromEmail: string
  /** Who received it. */
  toName: string
  toEmail: string
  /** What was handed over, in `currency`. */
  amountCents: number
  /**
   * What it was handed over IN. Defaults to the trip's currency, which is what
   * the settlement plan is denominated in and what the screen sends.
   */
  currency?: string
  /** The rate into the trip's currency, stated. As on an expense (#59). */
  fxRate?: string | number
  /** What actually left the sender's account, stated. Refused beside `fxRate`. */
  targetAmountCents?: number
  /** "Twint, Tuesday" — the human's own record of which payment this was. */
  note?: string | null
}

/**
 * What the entry is called. It is a real column on a real row, so it has to say
 * something, and what a reader of an audit log, a `/api/v1` budget or a list of
 * entries wants to know about a transfer is who paid whom.
 *
 * The names are FROZEN at write time, exactly like `paid_by_name` on an expense
 * — `ensureMemberAccounts` refreshes an account's name retroactively and this
 * does not move with it, so an old settlement can say "Ana" while the balances
 * say "Anna". Nothing computes anything from either; the identity is the email.
 */
function settlementTitle(fromName: string, toName: string): string {
  return `${fromName} → ${toName}`
}

/**
 * Record a payment one person made to another, as one balanced entry.
 *
 * The gates below decide who may; this decides what is written, and it is
 * deliberately a translation into `addExpense` rather than a write of its own:
 * the payer is the sender, the single share is the recipient, and the
 * destination is `transfer`, which writes no category line.
 *
 * `splitMode: 'even'` and not `'exact'`, for a split of one person where the
 * two are the same arithmetic. It is the mode that stays RE-DERIVABLE: an
 * `exact` row refuses a new total until the amounts come with it, so correcting
 * a mistyped settlement through the ordinary expense PATCH would be refused for
 * a split that has nothing to decide.
 */
export async function recordSettlement(eventId: string, input: RecordSettlementInput, by: ExpenseActor) {
  const fromEmail = input.fromEmail.trim().toLowerCase()
  const toEmail = input.toEmail.trim().toLowerCase()
  if (!fromEmail || !toEmail) {
    throw createError({ statusCode: 422, message: 'A payment needs the person who paid and the person who was paid' })
  }
  if (fromEmail === toEmail) {
    throw createError({
      statusCode: 422,
      message: 'A payment goes between two people. Paying yourself would change nobody\'s balance.'
    })
  }

  return addExpense(eventId, {
    title: settlementTitle(input.fromName.trim(), input.toName.trim()),
    amountCents: input.amountCents,
    currency: input.currency,
    fxRate: input.fxRate,
    targetAmountCents: input.targetAmountCents,
    note: input.note ?? null,
    paidByName: input.fromName.trim(),
    paidByEmail: fromEmail,
    splitMode: 'even',
    participants: [{ name: input.toName.trim(), email: toEmail }]
  }, by, 'transfer')
}

/**
 * Remove one — BY ANYBODY WHO MAY RECORD ONE, which is wider than removing an
 * expense (its recorder, its payer, or a planner) and is the issue's own
 * decision.
 *
 * A settlement is a claim about the physical world: somebody says a transfer
 * happened. A mistyped one that cannot be undone is worse than no feature at
 * all, because it leaves the ledger asserting a payment nobody made and the
 * only recourse is a second, opposite, equally fictional entry. Who recorded it
 * is on the entry (`created_by_user_id`, shown as "added by" like every
 * expense) and who removed it is in the audit log, which is the accountability
 * — not a narrower gate.
 *
 * IT MUST ACTUALLY BE A SETTLEMENT. An expense reached through this route is
 * refused rather than quietly deleted with the wider permission: that would
 * make the settlement route a way around `removeExpense`'s rule, which is the
 * kind of hole a second delete path exists to create.
 */
export async function removeSettlement(eventId: string, settlementId: string) {
  const db = useDb()
  const [row] = await db
    .select({ id: tables.expense.id })
    .from(tables.expense)
    .where(and(eq(tables.expense.id, settlementId), eq(tables.expense.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'No such payment on this trip' })

  // The shape, asked of the lines rather than of a column — the same question
  // `shared/utils/settlement.ts` asks of a rendered entry, one layer down.
  const [cost] = await db
    .select({ id: tables.expenseShare.id })
    .from(tables.expenseShare)
    .innerJoin(tables.account, eq(tables.account.id, tables.expenseShare.accountId))
    .where(and(eq(tables.expenseShare.expenseId, settlementId), eq(tables.account.kind, 'category')))
    .limit(1)
  if (cost) {
    throw createError({
      statusCode: 422,
      message: 'That entry is an expense, not a payment between two people. Remove it from the expense list.'
    })
  }

  await db.delete(tables.expense).where(eq(tables.expense.id, settlementId))
}

/* ------------------------- participant-scoped shape ------------------------ */

/**
 * Record a payment as a signed-in PARTICIPANT (#48's gate, imported rather than
 * re-stated): the event is open to the people invited to it, and this account
 * is one of them, with a role that covers the budget.
 *
 * Like an expense, it is not restricted to the two people named: "Ana paid
 * Matthew back on Tuesday, I'm entering it" is the same convenience that makes
 * the account gate bearable, and `created_by_user_id` records who typed it.
 */
export async function recordSettlementAsParticipant(
  actor: ParticipantActor,
  slug: string,
  input: RecordSettlementInput
) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  return recordSettlement(ev.id, input, { userId: actor.id })
}

/** Remove a payment as a participant. Anyone who may record one may remove one. */
export async function removeSettlementAsParticipant(actor: ParticipantActor, slug: string, settlementId: string) {
  const { ev } = await assertMayWriteExpenses(slug, actor)
  await removeSettlement(ev.id, settlementId)
  return loadBudget(ev.id)
}

/* --------------------------- planner-scoped shape -------------------------- */

/**
 * The same two on the host surface, gated the way its expense writes are:
 * `owner`/`co_planner` and no lifecycle check, because a planner reading the
 * same card on `/host` is the other place this is offered.
 */
async function assertMayPlanSettlements(userId: string, slug: string) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return ev
}

/** Record a payment as a planner (owner/co-planner only). */
export async function recordSettlementAsPlanner(userId: string, slug: string, input: RecordSettlementInput) {
  const ev = await assertMayPlanSettlements(userId, slug)
  return recordSettlement(ev.id, input, { userId })
}

/** Remove a payment as a planner (owner/co-planner only). */
export async function removeSettlementAsPlanner(userId: string, slug: string, settlementId: string) {
  const ev = await assertMayPlanSettlements(userId, slug)
  await removeSettlement(ev.id, settlementId)
  return loadBudget(ev.id)
}
