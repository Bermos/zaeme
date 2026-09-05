import { removeDateOption } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Withdraw a proposed date option (planner only; votes cascade away). */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  await removeDateOption(user.id, slug, id)
  return { ok: true }
})
