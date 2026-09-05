import { deleteTimelineItem } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { REMOVED } from '../../../../../utils/v1-shapes'

/** `removeTimelineItem`. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const itemId = getRouterParam(event, 'itemId')!
  await deleteTimelineItem(caller.planner.id, slug, itemId)
  return REMOVED
})
