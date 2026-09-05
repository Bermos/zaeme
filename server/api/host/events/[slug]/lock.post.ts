import { z } from 'zod'
import { lockDate } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'
import { dispatchEvent } from '../../../../utils/dispatch'

/**
 * Lock the winning date: stamps startsAt/endsAt from the option and publishes
 * the event (planner only) — firing the invites through the nervous system.
 */
const bodySchema = z.object({
  optionId: z.string().min(1)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const event = await lockDate(user.id, slug, body.optionId, { dispatch: dispatchEvent })
  return { event }
})
