import { z } from 'zod'
import { createParty, listInvites, loadPollForPlanner, getEventSummaryForPlanner } from '../../../domain/index'
import { defineServiceHandler } from '../../../utils/service-auth'
import { eventSummary, invite, pollOption } from '../../../utils/v1-shapes'

/**
 * `createPartyPlan` — a party's whole first stage in one call: create it, seed
 * the candidate dates, invite the small core group with personal links, and open
 * the poll. Stage two is `openUpParty`, after the date is locked.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
  coreInvites: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().optional()
  }).strict()).min(1).max(20),
  dateOptions: z.array(z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional(),
    note: z.string().max(500).optional()
  }).strict()).min(1).max(10)
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const body = bodySchema.parse(await readBody(event))
  const party = await createParty(caller.planner.id, body)

  // Read the three pieces the contract promises back from the domain rather
  // than re-deriving them from the create input.
  const [created, options, invites] = await Promise.all([
    getEventSummaryForPlanner(caller.planner.id, party.slug),
    loadPollForPlanner(caller.planner.id, party.slug),
    listInvites(caller.planner.id, party.slug)
  ])

  setResponseStatus(event, 201)
  return {
    event: eventSummary(created),
    options: options.map(pollOption),
    invites: invites.map(invite)
  }
})
