import { count, eq } from 'drizzle-orm'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { isCurrencyCode, normaliseCurrency } from '../utils/fx'

/**
 * The instance's own configuration — today exactly one setting, the currency a
 * NEW event starts in (#25, D6: "base currency settable by instance owner,
 * expectation is to have the same currency in the friends group. Default for us
 * is CHF").
 *
 * IT IS A DEFAULT AND NOTHING ELSE SINCE #59. Every balance hangs off
 * `events_event.currency`, so this value is read once, at event creation, and
 * never again: no total is denominated in it, no history is labelled by it, and
 * changing it moves no money. That is what let the 409 go — #25 had to freeze
 * this setting the moment an expense existed, because every balance on the
 * instance was stated in it, and a frozen setting on an instance with no
 * admin-side expense surface was effectively permanent.
 *
 * Why this is not in `admin.ts`: that module's contract, written at the top of
 * it, is that nothing there re-checks a permission because the only caller
 * allowed to ask is the instance owner. The default is read by every event
 * creation path, including ones a service token reaches, so it cannot live
 * behind that sentence. The admin surface writes it; the creation paths read
 * it.
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

/** The currency a new event is created in, unless something says otherwise. */
export async function instanceBaseCurrency(): Promise<string> {
  return (await loadInstanceSettings()).baseCurrency
}

/**
 * Change the currency new events start in.
 *
 * NOT REFUSED BY ANYTHING (#59). #25 answered 409 here while any expense was
 * recorded against a different base, because every balance on the instance was
 * denominated by this one value and letting it drift would have re-labelled
 * history — CHF cents summed under a heading that says EUR. Currency belongs to
 * the event now, so this value labels nothing that already exists: trips
 * underway keep what they have, and a trip that wants to move says so on its
 * own page, where the confirmation and the recompute are.
 */
export async function setInstanceBaseCurrency(input: string): Promise<InstanceSettings> {
  const baseCurrency = normaliseCurrency(input)
  if (!isCurrencyCode(baseCurrency)) {
    throw createError({ statusCode: 422, message: 'A base currency is a three-letter code, like CHF or EUR.' })
  }

  const db = useDb()
  return db.transaction(async (tx) => {
    // Insert-then-update rather than an upsert with a `set`: the row's id is
    // the whole primary key, so a second owner racing this one lands on the
    // same row and the later `update` wins, which is the ordinary last-write
    // outcome for a setting one person edits on one screen.
    await tx
      .insert(tables.instanceSetting)
      .values({ id: INSTANCE_SETTING_ID, baseCurrency })
      .onConflictDoNothing()
    await tx
      .update(tables.instanceSetting)
      .set({ baseCurrency })
      .where(eq(tables.instanceSetting.id, INSTANCE_SETTING_ID))
    const [row] = await tx.select().from(tables.instanceSetting).limit(1)
    return { baseCurrency: row!.baseCurrency, configured: true, updatedAt: row!.updatedAt }
  })
}

/** How many expenses exist on the instance at all — the admin page's context. */
export async function countRecordedExpenses(): Promise<number> {
  const db = useDb()
  const [row] = await db.select({ n: count() }).from(tables.expense)
  return row?.n ?? 0
}
