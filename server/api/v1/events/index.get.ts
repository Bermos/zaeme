import { listEvents } from '../../../domain/index'
import { defineServiceHandler } from '../../../utils/service-auth'
import { eventSummary } from '../../../utils/v1-shapes'

/** `listEvents` — the user's events, newest first. */
export default defineServiceHandler(async (_event, caller) => {
  const rows = await listEvents(caller.planner.id)
  return rows.map(eventSummary)
})
