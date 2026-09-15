import { z } from 'zod'
import { addLegAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Add a leg between two of this trip's places (owner/co-planner only).
 *
 * `isPlanned` DEFAULTS TO TRUE HERE and to false on the guest surface, which is
 * the difference the column exists for: a planner adding "Zug → Lugano, the
 * 09:14" is stating an intention, and a friend posting through their invite
 * link is reporting what happened. Either surface can say so explicitly; the
 * default is what each one means when it says nothing.
 */
const bodySchema = z.object({
  fromPlaceId: z.string().min(1).max(64),
  toPlaceId: z.string().min(1).max(64),
  mode: z.enum(['walk', 'bike', 'car', 'train', 'bus', 'ferry', 'plane', 'other']),
  departsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  arrivesAt: z.iso.datetime({ offset: true }).optional().nullable(),
  durationMinutes: z.number().int().min(0).max(100000).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  isPlanned: z.boolean().optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const geography = await addLegAsPlanner(user.id, slug, { ...body, isPlanned: body.isPlanned ?? true })
  setResponseStatus(e, 201)
  return geography
})
