import { z } from 'zod'
import { searchPlacesAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Search for a place instead of typing its name (#32).
 *
 * A read, and the HOST SESSION's alone — not the invite capability URL the
 * issue also offers it to. A forwarded link would otherwise let a stranger
 * drive queries at Nominatim under this instance's identifying `User-Agent`;
 * the reasoning, and how to widen it if the owner opens guest places, is at
 * `searchPlacesAsPlanner` in `server/domain/geocode.ts`.
 *
 * ALWAYS 200 WHEN THE CALLER IS ALLOWED TO ASK. A geocoder that is down, slow
 * or rate-limiting comes back as `status: 'unavailable'` with a reason, not as
 * a 5xx: the place form has to keep working without it, and an error status
 * would make the browser's `$fetch` throw into a search box. The one refusal
 * this route makes of its own is a query too short to be one (422), which is
 * deliberately NOT an empty result list — "type more" and "no such place" are
 * different sentences.
 */
const querySchema = z.object({ q: z.string().min(1).max(200) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const { q } = await getValidatedQuery(e, querySchema.parse)
  return searchPlacesAsPlanner(user.id, slug, q)
})
