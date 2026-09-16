import { asc, eq, inArray } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import { ensureEventAccountsWithin } from './accounts'
import {
  assertEntryBalances,
  buildEntryLines,
  convertCents,
  deriveRate,
  type FxRateSource,
  type LedgerLine,
  loadBudget
} from './expenses'
import { fetchFxRate, isCurrencyCode, normaliseCurrency } from '../utils/fx'

/**
 * CHANGING WHAT A TRIP SETTLES IN (#59).
 *
 * The recorded facts are never touched: `amountCents` and `currency` on every
 * entry, the as-spent amount on every line, and — since the #59 review —
 * `stated_amount_cents`/`stated_currency`, which are what the payer said they
 * were out of pocket and in what. What moves is everything DERIVED from them:
 * each entry's converted total, each person's converted share, and therefore
 * every balance, the trip total and the settlement plan.
 *
 * THAT THE STATED FIGURE IS KEPT IS NOT THE SAME AS IT BEING USED. Nothing here
 * reads those two columns; `amount_base_cents` is chained exactly as it was.
 * What they buy is that the chaining is REVERSIBLE and auditable: without them
 * a CHF 234.00 hotel that goes CHF → EUR → CHF at real (non-inverse) rates
 * comes back 235.18 and there is no record anywhere that 234.00 was ever the
 * number, while the row goes on saying `manual`. Whether a recomputation should
 * snap such a row back, or re-derive it and warn, is the owner's call; this
 * file does the conservative thing and keeps the evidence.
 *
 * ONE RATE, FETCHED ONCE, APPLIED TO THE FROZEN FIGURES. Not a fresh lookup per
 * expense currency, which is the other thing this could have been. The reason
 * is the rule the whole issue rests on: the amount to split is what the payer
 * actually paid. A row whose rate somebody typed off a bank statement carries a
 * fee no mid-market rate reproduces, and re-deriving that row from the receipt
 * would throw the fee away and hand the payer the difference to swallow — "you
 * had to pay a foreign-transaction charge, seems like a you problem". Carrying
 * the stated figure through one old → new conversion keeps it. The cost, stated
 * rather than hidden: a `fetched` row's new rate is a chained one rather than
 * today's direct quote, and CHF → EUR → CHF does not land back on exactly the
 * figure it started from. The identity case below is what stops that
 * accumulating for the rows it can.
 *
 * AN ENTRY THIS INSTANCE CONVERTED, WHOSE RECEIPT IS IN THE NEW CURRENCY,
 * CONVERTS AT 1. When a trip moves to EUR, a EUR receipt nobody has said
 * anything about stops being converted at all: rate 1, target equal to the
 * receipt, every share equal to its as-spent amount, exactly. That is both
 * obviously right — the merchant's figure IS the figure — and the reason
 * "change it, change it back, change it again" does not drift for a group
 * spending mostly one currency.
 *
 * IT DOES NOT APPLY TO A ROW SOMEBODY STATED, and that exception is the rule
 * about what is split, not an edge case. Ana's EUR 245.25 hotel cost her
 * CHF 234.00 because her bank charged `price × rate × fee`; when the trip moves
 * to EUR she is owed what she was actually out of pocket — CHF 234.00 in EUR —
 * and not the merchant's EUR 245.25, which is less. Snapping her back to the
 * receipt would hand her the bank's cut to swallow, which is exactly the "seems
 * like a you problem" this issue exists to refuse. So a `manual` row carries its
 * stated figure through every change, in both directions, and is never
 * overwritten by anything this instance derives.
 *
 * EACH SHARE IS RE-EXPRESSED ON ITS OWN, and that is the one place this file
 * departs from `addExpense`. On a write the per-person figures do not exist
 * yet: they are derived from a total, so converting each separately would
 * INVENT a cent of liability (#61). Here they already exist, as debts people
 * may have settled against, so re-apportioning them against a new total would
 * silently move money between friends behind their backs. Converting eleven
 * numbers at one rate does not give the same answer as converting their sum,
 * and that difference goes on the event's `Rounding` account, where somebody
 * can read it. The member lines of an entry still sum to zero by construction
 * (`buildEntryLines` credits the payer the sum of the debits), which is what
 * keeps the settlement plan closing exactly.
 *
 * NO LOCK-OUT, EVER. A settlement is an entry like any other, so recomputing
 * after people have started settling up re-derives those entries with
 * everything else and the nets still clear. Doing it halfway through is
 * annoying; it is fixed by peer pressure, not by a refusal from this program.
 */

/** Who may change it: the same set that may change any other event setting. */
const CURRENCY_CHANGERS = ['owner', 'co_planner'] as const

export interface SetEventCurrencyInput {
  /** The three-letter code this trip should settle in from now on. */
  currency: string
  /**
   * The old → new rate, by hand. Omit it and today's is fetched; supply it and
   * nothing is fetched, which is the same override the expense form has and the
   * only way through on an instance with no outbound network.
   */
  fxRate?: string | number
}

/** What a recompute did, so the screen can say it rather than imply it. */
export interface CurrencyChangeResult {
  from: string
  to: string
  /** The rate every frozen figure was carried across at. `'1'` on a no-op. */
  fxRate: string
  /** How many entries were re-expressed. */
  entriesRecomputed: number
  /**
   * How many of those were `manual` — somebody's own figure, carried through
   * rather than re-derived from the receipt. The screen names this because it
   * is the promise the confirmation made.
   */
  manualRatesKept: number
  /** Cents left on `Rounding` by this change, signed. Usually a handful. */
  roundingCents: number
}

/**
 * One entry's lines, grouped into the parts a rebuild needs.
 *
 * The shapes are read off the SIGNS and the account kinds, which is the whole
 * point of the ledger: a payer credit is the negative member line, a share is a
 * positive one, the cost is the positive category line. Nothing carries a flag
 * that could be out of date.
 */
export interface EntryLines {
  payer: { accountId: string, amountCents: number, amountBaseCents: number } | null
  categoryAccountId: string | null
  shares: Array<{ accountId: string, amountCents: number, amountBaseCents: number, weight: string | null }>
}

/**
 * Re-express one entry in the new currency.
 *
 * `identity` is the case where the receipt is already in the new currency: no
 * arithmetic at all, the shares ARE their as-spent amounts, and the entry comes
 * out exact. Otherwise every frozen figure goes through the same rate.
 *
 * Exported so the arithmetic can be pinned without a database: the transaction
 * around it is Postgres's business, but "eleven debts converted at one rate,
 * and the cent that leaves over" is this function's, and a unit test reddens in
 * 300ms what otherwise needs a built server and a live Postgres.
 */
export function recomputeEntry(input: {
  grouped: EntryLines
  amountCents: number
  amountBaseCents: number
  roundingAccountId: string
  identity: boolean
  rate: string
}): { lines: LedgerLine[], amountBaseCents: number } {
  const { grouped, identity, rate } = input
  if (!grouped.payer) {
    throw createError({
      statusCode: 500,
      message: 'An entry on this trip has no payer line, so it cannot be re-expressed. Nothing was changed.'
    })
  }
  const target = identity ? input.amountCents : convertCents(input.amountBaseCents, rate)
  const lines = buildEntryLines({
    amountCents: input.amountCents,
    amountBaseCents: target,
    payerAccountId: grouped.payer.accountId,
    categoryAccountId: grouped.categoryAccountId,
    roundingAccountId: input.roundingAccountId,
    shares: grouped.shares.map(share => ({
      accountId: share.accountId,
      amountCents: share.amountCents,
      // Each debt on its own, at the one rate — see the file header for why
      // this is not the write path's group apportionment.
      amountBaseCents: identity ? share.amountCents : convertCents(share.amountBaseCents, rate),
      weight: share.weight
    }))
  })
  assertEntryBalances(lines)
  return { lines, amountBaseCents: target }
}

/**
 * Change the currency a trip settles in and re-express every entry on it.
 *
 * One transaction, holding the event row: `addExpense` takes the same lock, so
 * an expense being recorded while this runs either lands before the recompute
 * and is re-expressed with everything else, or is refused with a 409 naming
 * what happened. Neither outcome is a row stamped with a currency that is no
 * longer the trip's.
 */
export async function setEventCurrency(
  eventId: string,
  input: SetEventCurrencyInput
): Promise<CurrencyChangeResult> {
  const to = normaliseCurrency(input.currency)
  if (!isCurrencyCode(to)) {
    throw createError({ statusCode: 422, message: 'A currency is a three-letter code, like CHF or EUR.' })
  }

  const db = useDb()
  const [before] = await db
    .select({ currency: tables.event.currency })
    .from(tables.event)
    .where(eq(tables.event.id, eventId))
    .limit(1)
  if (!before) throw createError({ statusCode: 404, message: 'Event not found' })
  const from = before.currency
  if (from === to) {
    return { from, to, fxRate: '1', entriesRecomputed: 0, manualRatesKept: 0, roundingCents: 0 }
  }

  // Outside the transaction, like every other outbound call in this domain.
  const stated = input.fxRate !== undefined && input.fxRate !== null && `${input.fxRate}`.trim() !== ''
    ? `${input.fxRate}`.trim()
    : null
  let rate = stated
  if (rate === null) {
    const quote = await fetchFxRate(from, to)
    if (!quote) {
      throw createError({
        statusCode: 422,
        message: `No ${from} → ${to} rate could be fetched just now. Enter the rate yourself and every amount will be recomputed with it.`
      })
    }
    rate = quote.rate
  }
  // Refuse a rate the column cannot hold BEFORE anything is written: the first
  // `convertCents` would otherwise abort mid-recompute, which rolls back but
  // reports a failure about one entry rather than about the rate.
  convertCents(100, rate)

  let entriesRecomputed = 0
  let manualRatesKept = 0
  let roundingCents = 0

  await db.transaction(async (tx) => {
    const [held] = await tx
      .select({ currency: tables.event.currency })
      .from(tables.event)
      .where(eq(tables.event.id, eventId))
      .for('update')
      .limit(1)
    if (!held) throw createError({ statusCode: 404, message: 'Event not found' })
    if (held.currency !== from) {
      throw createError({
        statusCode: 409,
        message: `This trip's currency changed to ${held.currency} while this was being applied. Try again.`
      })
    }

    const accounts = await ensureEventAccountsWithin(tx, eventId)
    const rounding = accounts.find(a => a.kind === 'rounding')
    if (!rounding) throw createError({ statusCode: 500, message: 'This event has no Rounding account' })
    const byId = new Map(accounts.map(a => [a.id, a]))

    const entries = await tx
      .select()
      .from(tables.expense)
      .where(eq(tables.expense.eventId, eventId))
      .orderBy(asc(tables.expense.createdAt))

    const lineRows = entries.length
      ? await tx
          .select()
          .from(tables.expenseShare)
          .where(inArray(tables.expenseShare.expenseId, entries.map(e => e.id)))
          .orderBy(asc(tables.expenseShare.seq), asc(tables.expenseShare.id))
      : []

    const grouped = new Map<string, EntryLines>()
    for (const l of lineRows) {
      let g = grouped.get(l.expenseId)
      if (!g) {
        g = { payer: null, categoryAccountId: null, shares: [] }
        grouped.set(l.expenseId, g)
      }
      const kind = byId.get(l.accountId)?.kind
      if (kind === 'member' && l.amountCents < 0) {
        g.payer = { accountId: l.accountId, amountCents: l.amountCents, amountBaseCents: l.amountBaseCents }
      } else if (kind === 'member') {
        g.shares.push({
          accountId: l.accountId,
          amountCents: l.amountCents,
          amountBaseCents: l.amountBaseCents,
          weight: l.weight
        })
      } else if (kind === 'category' && l.amountCents > 0) {
        g.categoryAccountId = l.accountId
      }
      // The old rounding line and the category credit are DROPPED rather than
      // carried: both are derived, and `buildEntryLines` computes them again
      // from the figures above. Carrying a stale residual forward would add
      // this change's cents to the last one's.
    }

    for (const entry of entries) {
      const g = grouped.get(entry.id)
      // An entry with no lines at all cannot be re-expressed, and SKIPPING it
      // is the worst of the three options: the event's currency changes around
      // it and the row is left labelled in a currency the trip no longer
      // settles in, silently, forever. The transaction is open, so throwing
      // rolls the whole change back and changes nothing.
      if (!g) {
        throw createError({
          statusCode: 500,
          message: `The entry "${entry.title}" has no ledger lines, so this trip cannot be re-expressed. Nothing was changed.`
        })
      }
      // `fetched` is half the condition, not a detail: see the file header. A
      // figure a person stated is carried across even into the currency its own
      // receipt is in, because the fee they paid is real and theirs to recover.
      const identity = entry.currency === to && entry.fxRateSource === 'fetched'
      const { lines, amountBaseCents } = recomputeEntry({
        grouped: g,
        amountCents: entry.amountCents,
        amountBaseCents: entry.amountBaseCents,
        roundingAccountId: rounding.id,
        identity,
        rate: rate!
      })

      // Nothing here can turn a `manual` row into a `fetched` one: the identity
      // case is only ever reached by a row that was already `fetched`, so the
      // label a person earned survives every change. It is carried through
      // rather than recomputed so that reading it means what it says — and
      // `stated_amount_cents`/`stated_currency` are not in the `set` below at
      // all, so the figure behind the label survives with it.
      const fxRateSource: FxRateSource = entry.fxRateSource
      if (fxRateSource === 'manual') manualRatesKept++
      roundingCents += lines
        .filter(l => l.accountId === rounding.id)
        .reduce((sum, l) => sum + l.amountBaseCents, 0)
      entriesRecomputed++

      await tx.update(tables.expense).set({
        baseCurrency: to,
        // The EFFECTIVE rate from the receipt to the new currency, derived from
        // the pair the row now holds. A `manual` row's fee is inside it, which
        // is why it is derived rather than copied from `rate`.
        fxRate: identity ? '1' : deriveRate(entry.amountCents, amountBaseCents),
        fxRateSource,
        amountBaseCents
      }).where(eq(tables.expense.id, entry.id))

      await tx.delete(tables.expenseShare).where(eq(tables.expenseShare.expenseId, entry.id))
      await tx.insert(tables.expenseShare).values(lines.map((line, seq) => ({
        id: createId(),
        expenseId: entry.id,
        eventId,
        accountId: line.accountId,
        seq,
        amountCents: line.amountCents,
        amountBaseCents: line.amountBaseCents,
        weight: line.weight
      })))
    }

    await tx.update(tables.event).set({ currency: to }).where(eq(tables.event.id, eventId))
  })

  return { from, to, fxRate: rate!, entriesRecomputed, manualRatesKept, roundingCents }
}

/* ----------------------------- planner-scoped ------------------------------ */

/**
 * Change a trip's currency as a planner.
 *
 * `owner`/`co_planner`, matching every other event setting and deliberately not
 * `logistics`: a participant may record what they spent, but the basis everyone
 * settles in is a different kind of act.
 *
 * NO LIFECYCLE CHECK, and no refusal once expenses exist. The confirmation the
 * screen shows before calling this is the whole of the protection — it says
 * plainly that every amount will be recomputed at today's rates — and a trip
 * whose friends have started paying each other back is still allowed to move,
 * because a settlement is an entry like any other and re-derives with the rest.
 */
export async function setEventCurrencyAsPlanner(userId: string, slug: string, input: SetEventCurrencyInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: [...CURRENCY_CHANGERS] })
  const change = await setEventCurrency(ev.id, input)
  return { change, budget: await loadBudget(ev.id) }
}
