import { removeSeriesMemberOne } from '../../../../../../domain/index'
import { defineServiceHandler } from '../../../../../../utils/service-auth'
import { REMOVED } from '../../../../../../utils/v1-shapes'

/** `removeSeriesMember` — they keep invites to already-scheduled showings. */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const memberId = getRouterParam(event, 'memberId')!
  await removeSeriesMemberOne(caller.planner.id, slug, memberId)
  return REMOVED
})
