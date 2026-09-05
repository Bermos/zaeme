import { listSeriesMembersForPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { seriesMember } from '#server/utils/v1-shapes'

/** `listSeriesMembers` — the standing group invited to every showing. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listSeriesMembersForPlanner(caller.planner.id, slug)).map(seriesMember)
})
