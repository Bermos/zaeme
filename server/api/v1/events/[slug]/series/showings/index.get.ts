import { listSeriesShowings } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { showing } from '#server/utils/v1-shapes'

/** `listSeriesShowings` — the scheduled occurrences with their sign-up counts. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listSeriesShowings(caller.planner.id, slug)).map(showing)
})
