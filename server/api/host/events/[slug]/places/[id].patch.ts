import { z } from 'zod'
import { updatePlaceAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Correct a place, or give one its coordinates afterwards (owner/co-planner).
 *
 * "Coordinates added later" is an acceptance criterion of #30 and this is the
 * route that does it. They still move as a PAIR: a patch carrying one of the
 * two is refused by the domain rather than leaving the row half-coordinated.
 */
const coordinate = z.union([z.number(), z.string().max(32)])

const bodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: z.string().max(500).optional().nullable(),
  lat: coordinate.optional().nullable(),
  lng: coordinate.optional().nullable(),
  osmType: z.enum(['node', 'way', 'relation']).optional().nullable(),
  osmId: z.string().max(64).optional().nullable(),
  note: z.string().max(2000).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return updatePlaceAsPlanner(user.id, slug, id, body)
})
