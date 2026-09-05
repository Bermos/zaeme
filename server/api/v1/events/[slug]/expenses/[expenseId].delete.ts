import { removeExpenseAsPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { REMOVED } from '#server/utils/v1-shapes'

/** `removeTripExpense` — the expense and its shares. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const expenseId = getRouterParam(event, 'expenseId')!
  await removeExpenseAsPlanner(caller.planner.id, slug, expenseId)
  return REMOVED
})
