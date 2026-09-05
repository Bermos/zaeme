import { loadBudgetForPlanner } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { budget } from '../../../../utils/v1-shapes'

/** `getTripBudget` — expenses, per-person balances and the settlement plan, in cents. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return budget(await loadBudgetForPlanner(caller.planner.id, slug))
})
