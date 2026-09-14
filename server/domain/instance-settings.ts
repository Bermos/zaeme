import { count, ne } from 'drizzle-orm'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { isCurrencyCode, normaliseCurrency } from '../utils/fx'

/**
 * The instance's own configuration — today exactly one setting, the BASE
 * CURRENCY the whole instance settles up in (#25, D6: "base currency settable
 * by instance owner, expectation is to have the same currency in the friends
 * group. Default for us is CHF").
 *
 * Why this is not in `admin.ts`: that module's contract, written at the top of
 * it, is that nothing there re-checks a permission because the only caller
 * allowed to ask is the instance owner. The base currency is read on EVERY
 * budget load, including the guest one behind an invite capability URL, so it
 * cannot live behind that sentence. The admin surface writes it; everybody
 * reads it.
 *
 * Deliberately uncached. It is one primary-key lookup, and a cache is how a
 * setting the owner just changed keeps answering with the old value for as long
 * as the process lives.
 */

/** The one row. There is one instance per deployment; this is its id. */
export const INSTANCE_SETTING_ID = 'instance'

/** What an instance that has never been configured settles up in. */
export const DEFAULT_BASE_CURRENCY = 'CHF'

export interface InstanceSettings {
  baseCurrency: string
  /** False when no row exists yet — the instance is still on the defaults. */
  configured: boolean
  updatedAt: Date | null
}

/** The instance settings, or the defaults when nobody has set any. */
export async function loadInstanceSettings(): Promise<InstanceSettings> {
  const db = useDb()
  const [row] = await db.select().from(tables.instanceSetting).limit(1)
  if (!row) return { baseCurrency: DEFAULT_BASE_CURRENCY, configured: false, updatedAt: null }
  return { baseCurrency: row.baseCurrency, configured: true, updatedAt: row.updatedAt }
}

/** The currency every balance on this instance is expressed in. */
export async function instanceBaseCurrency(): Promise<string> {
  return (await loadInstanceSettings()).baseCurrency
}

/**
 * Change what the instance settles up in.
 *
 * REFUSED (409) while any expense is recorded against a different base, and
 * that refusal is the thing holding the whole feature together. Every expense
 * freezes `base_currency` and `amount_base_cents` at write time; a balance is
 * the plain sum of those. Let the instance base drift away from the one the
 * rows carry and the sum is adding CHF cents under a heading that says EUR —
 * which is the bug this issue exists to fix, wearing a different hat.
 *
 * The two alternatives were both worse: re-converting history at today's rate
 * moves balances people have already settled, and reporting a budget in the
 * currency of its own rows makes "the instance base currency" a thing no screen
 * can state. Deleting the expenses, or leaving the base alone, are both choices
 * the owner can make knowingly.
 */
export async function setInstanceBaseCurrency(input: string): Promise<InstanceSettings> {
  const baseCurrency = normaliseCurrency(input)
  if (!isCurrencyCode(baseCurrency)) {
    throw createError({ statusCode: 422, message: 'A base currency is a three-letter code, like CHF or EUR.' })
  }

  const db = useDb()
  const [{ blocking } = { blocking: 0 }] = await db
    .select({ blocking: count() })
    .from(tables.expense)
    .where(ne(tables.expense.baseCurrency, baseCurrency))
  if (blocking > 0) {
    throw createError({
      statusCode: 409,
      message: `${blocking} expense${blocking === 1 ? ' is' : 's are'} already recorded against a different base currency. `
        + 'Changing it now would re-label balances that were converted at the old one — remove those expenses first, or keep the current base.'
    })
  }

  await db
    .insert(tables.instanceSetting)
    .values({ id: INSTANCE_SETTING_ID, baseCurrency })
    .onConflictDoUpdate({ target: tables.instanceSetting.id, set: { baseCurrency } })
  return loadInstanceSettings()
}

/** How many expenses exist on the instance at all — the admin page's context. */
export async function countRecordedExpenses(): Promise<number> {
  const db = useDb()
  const [row] = await db.select({ n: count() }).from(tables.expense)
  return row?.n ?? 0
}
