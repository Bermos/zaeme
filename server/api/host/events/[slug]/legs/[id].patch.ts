import { z } from 'zod'
import { updateLegAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Correct a leg (owner/co-planner only) — including flipping `isPlanned`, which
 * is how "the 09:14 we meant to take" becomes "the one we actually got on".
 */
const bodySchema = z.object({
  fromPlaceId: z.string().min(1).max(64).optional(),
  toPlaceId: z.string().min(1).max(64).optional(),
  mode: z.enum(['walk', 'bike', 'car', 'train', 'bus', 'ferry', 'plane', 'other']).optional(),
  departsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  arrivesAt: z.iso.datetime({ offset: true }).optional().nullable(),
  durationMinutes: z.number().int().min(0).max(100000).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  isPlanned: z.boolean().optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return updateLegAsPlanner(user.id, slug, id, body)
})
