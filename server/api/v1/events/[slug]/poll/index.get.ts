import { loadPollForPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { pollOption } from '../../../../../utils/v1-shapes'

/** `listDatePoll` — the candidate dates with each participant's vote and the tally. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await loadPollForPlanner(caller.planner.id, slug)).map(pollOption)
})
