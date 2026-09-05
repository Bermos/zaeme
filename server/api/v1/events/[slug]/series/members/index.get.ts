import { listSeriesMembersForPlanner } from '../../../../../../domain/index'
import { defineServiceHandler } from '../../../../../../utils/service-auth'
import { seriesMember } from '../../../../../../utils/v1-shapes'

/** `listSeriesMembers` — the standing group invited to every showing. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listSeriesMembersForPlanner(caller.planner.id, slug)).map(seriesMember)
})
