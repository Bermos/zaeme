import { listTimeline } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { timelineItem } from '../../../../../utils/v1-shapes'

/** `listTimeline` — the itinerary in display order. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listTimeline(caller.planner.id, slug)).map(timelineItem)
})
