import { z } from 'zod'
import { reverseGeocodeAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Name a dropped pin (#32) — the other direction of the same search.
 *
 * `lat`/`lng` arrive as the strings they were typed or dragged as, exactly as
 * they do on `POST .../places`: the domain is what checks the range, rounds to
 * the column's six decimals and refuses one of the pair without the other, so
 * there is one rule and not two that drift.
 *
 * Same credential and the same degrade as `search.get.ts`: the host session,
 * always 200 when the caller may ask, `status: 'unavailable'` when the geocoder
 * cannot be reached.
 */
const querySchema = z.object({
  lat: z.union([z.string().max(32), z.number()]),
  lng: z.union([z.string().max(32), z.number()])
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const { lat, lng } = await getValidatedQuery(e, querySchema.parse)
  return reverseGeocodeAsPlanner(user.id, slug, lat, lng)
})
