import { loadPollForPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { pollOption } from '#server/utils/v1-shapes'

/** `listDatePoll` — the candidate dates with each participant's vote and the tally. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await loadPollForPlanner(caller.planner.id, slug)).map(pollOption)
})
