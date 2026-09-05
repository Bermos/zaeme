import { z } from 'zod'
import { addDateOption, loadEventBySlug, loadPollForPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { asInvalidTransition } from '../../../../../utils/api-v1'
import { pollOption } from '../../../../../utils/v1-shapes'

/** `proposeDateOption` — one candidate date; call once per date. */
const bodySchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().max(500).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const current = await loadEventBySlug(slug)
  const created = await asInvalidTransition(
    () => addDateOption(caller.planner.id, slug, body),
    { from: current.status }
  )
  // The contract answers a full PollOption; a brand-new option has no votes, so
  // the tally is read back from the domain rather than assumed here.
  const option = (await loadPollForPlanner(caller.planner.id, slug)).find(o => o.id === created!.id)
  setResponseStatus(event, 201)
  return pollOption(option ?? { ...created, votes: [], tally: { yes: 0, ifneedbe: 0, no: 0 } })
})
