import { listTimeline } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { timelineItem } from '#server/utils/v1-shapes'

/** `listTimeline` — the itinerary in display order. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listTimeline(caller.planner.id, slug)).map(timelineItem)
})
