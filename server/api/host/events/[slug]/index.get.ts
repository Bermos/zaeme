import {
  getEventForPlanner,
  listContributions,
  listInvites,
  listOccurrences,
  listRsvps,
  listSeriesMembers,
  listTimeline,
  loadBudget,
  loadGeography,
  loadPoll
} from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** Everything the manage page needs, in one aggregate (planner only). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!

  const event = await getEventForPlanner(user.id, slug)
  const isSeries = event.type === 'series'
  const [poll, invites, rsvps, contributions, timeline, budget, geography, members, occurrences] = await Promise.all([
    loadPoll(event.id),
    listInvites(user.id, slug),
    listRsvps(user.id, slug),
    listContributions(event.id),
    listTimeline(user.id, slug),
    loadBudget(event.id),
    // The trip's places and the legs between them (#30). Part of the aggregate
    // rather than a second round trip, for the same reason everything else
    // here is: the manage page is one screen and should be one request.
    loadGeography(event.id),
    isSeries ? listSeriesMembers(event.id) : Promise.resolve([]),
    isSeries ? listOccurrences(event.id) : Promise.resolve([])
  ])

  return {
    event,
    poll,
    invites,
    rsvps: rsvps.rsvps,
    summary: rsvps.summary,
    contributions,
    timeline,
    budget,
    geography,
    members,
    occurrences
  }
})
