import { z } from 'zod'
import { addDateOption, loadEventBySlug, loadPollForPlanner } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { asInvalidTransition } from '#server/utils/api-v1'
import { pollOption } from '#server/utils/v1-shapes'

/** `proposeDateOption` — one candidate date; call once per date. */
const bodySchema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
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
