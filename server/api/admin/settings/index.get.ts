import { baseCurrencyHold, loadInstanceSettings } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * The instance's own settings. Today that is one question — what currency does
 * this group settle up in — and, beside it, exactly what is holding the answer
 * in place.
 *
 * The hold matters more than the setting. Once an expense exists, the base is
 * frozen (`setInstanceBaseCurrency`), and zäme has no admin-side way to remove
 * an expense: the escape is to open the trips that hold them as a planner. So
 * this returns those trips by name rather than a count, and the page says so
 * while the setting is still free rather than after it is not.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const hold = await baseCurrencyHold()
  return {
    settings: await loadInstanceSettings(),
    expensesRecorded: hold.total,
    hold
  }
})
