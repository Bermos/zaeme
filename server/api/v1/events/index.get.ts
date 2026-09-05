import { listEvents } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { eventSummary } from '#server/utils/v1-shapes'

/** `listEvents` — the user's events, newest first. */
export default defineServiceHandler(async (_event, caller) => {
  const rows = await listEvents(caller.planner.id)
  return rows.map(eventSummary)
})
