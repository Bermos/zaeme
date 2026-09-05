import { listContributionsForPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { contribution } from '#server/utils/v1-shapes'

/** `listPotluck` — the bring-list, with who has claimed what. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listContributionsForPlanner(caller.planner.id, slug)).map(contribution)
})
