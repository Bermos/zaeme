import { z } from 'zod'
import { createInvite } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/**
 * Create an invite link (planner only). The two zäme access tiers map directly
 * (ADR-0019 §3): a SHAREABLE link (no email/name, unlimited or capped uses —
 * "friends+") or a PERSONALISED one (name/email set — "friends").
 */
const bodySchema = z.object({
  label: z.string().max(200).optional().nullable(),
  email: z.string().email().optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  maxUses: z.number().int().positive().optional().nullable(),
  expiresAt: z.string().datetime({ offset: true }).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const invite = await createInvite(user.id, slug, body)
  return { invite }
})
