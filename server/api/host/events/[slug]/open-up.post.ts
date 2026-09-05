import { z } from 'zod'
import { openUpParty } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'
import { dispatchEvent } from '../../../../utils/dispatch'

/**
 * Party stage 2: after the core group's date is locked (published), mint the
 * open-invitation link for everyone who has time.
 */
const bodySchema = z.object({
  label: z.string().max(200).optional().nullable(),
  maxUses: z.number().int().positive().max(10000).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const invite = await openUpParty(user.id, slug, body, { dispatch: dispatchEvent })
  return { invite }
})
