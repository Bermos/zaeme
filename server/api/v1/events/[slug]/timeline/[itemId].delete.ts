import { deleteTimelineItem } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { REMOVED } from '#server/utils/v1-shapes'

/** `removeTimelineItem`. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const itemId = getRouterParam(event, 'itemId')!
  await deleteTimelineItem(caller.planner.id, slug, itemId)
  return REMOVED
})
