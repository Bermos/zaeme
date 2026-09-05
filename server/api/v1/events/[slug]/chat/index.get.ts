import { listMessagesForPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { chatMessage } from '../../../../../utils/v1-shapes'

/** `readEventChat` — oldest first; `afterId` is the incremental read. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const afterId = getQuery(event).afterId
  return (await listMessagesForPlanner(caller.planner.id, slug, {
    afterId: typeof afterId === 'string' ? afterId : null
  })).map(chatMessage)
})
