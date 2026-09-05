import { listContributionsForPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { contribution } from '../../../../../utils/v1-shapes'

/** `listPotluck` — the bring-list, with who has claimed what. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listContributionsForPlanner(caller.planner.id, slug)).map(contribution)
})
