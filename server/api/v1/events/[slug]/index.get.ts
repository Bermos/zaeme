import { getEventDetailForPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { eventDetail } from '#server/utils/v1-shapes'

/** `getEvent` — one event and its planner team. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return eventDetail(await getEventDetailForPlanner(caller.planner.id, slug))
})
