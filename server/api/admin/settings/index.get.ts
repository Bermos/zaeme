import { countRecordedExpenses, loadInstanceSettings } from '#server/domain/index'
import { requireOwner } from '#server/utils/admin'

/**
 * The instance's own settings. Today that is one question — what currency does
 * this group settle up in — and the count beside it, because the answer can
 * only be changed while no expense is recorded against a different base.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return {
    settings: await loadInstanceSettings(),
    expensesRecorded: await countRecordedExpenses()
  }
})
