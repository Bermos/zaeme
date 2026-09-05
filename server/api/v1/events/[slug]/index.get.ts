import { getEventDetailForPlanner } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { eventDetail } from '../../../../utils/v1-shapes'

/** `getEvent` — one event and its planner team. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return eventDetail(await getEventDetailForPlanner(caller.planner.id, slug))
})
