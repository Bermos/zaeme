import { z } from 'zod'
import { addPlaceAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Add a place to the trip (owner/co-planner only).
 *
 * `lat`/`lng` are optional and take a number or a string — a form sends the
 * first, a geocoder (#32) the second — and the domain is what refuses one
 * without the other, checks the range and rounds to the column's six decimals.
 * A place with NEITHER is the ordinary case, not a draft: "Ana's flat" is a
 * place and will never have a coordinate.
 */
const coordinate = z.union([z.number(), z.string().max(32)])

const bodySchema = z.object({
  name: z.string().min(1).max(200),
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
  const body = await readValidatedBody(e, bodySchema.parse)
  const geography = await addPlaceAsPlanner(user.id, slug, body)
  setResponseStatus(e, 201)
  return geography
})
