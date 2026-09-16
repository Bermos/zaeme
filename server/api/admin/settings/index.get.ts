import { countRecordedExpenses, loadInstanceSettings } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * The instance's own settings. Today that is one question — what currency does
 * a NEW trip start in — and nothing is holding the answer in place any more.
 *
 * It used to return a `hold`: the list of trips whose expenses froze the
 * instance base, because #25 refused to change it while any existed. Currency
 * belongs to the event since #59, so this setting labels no money that already
 * exists and changing it re-states nothing; the warning UI built to soften that
 * refusal went with the refusal.
 *
 * `expensesRecorded` stays as plain context — "this instance has money in it" —
 * and no longer implies anything is locked.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return {
    settings: await loadInstanceSettings(),
    expensesRecorded: await countRecordedExpenses()
  }
})
