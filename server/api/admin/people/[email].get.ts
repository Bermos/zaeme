import { personDetail } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'

/** One person in full: every answer, link and membership under their email. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const email = decodeURIComponent(getRouterParam(e, 'email')!)
  return personDetail(email)
})
