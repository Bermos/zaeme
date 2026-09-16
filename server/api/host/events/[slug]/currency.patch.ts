import { z } from 'zod'
import { setEventCurrencyAsPlanner } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Change what this trip settles in, and recompute every amount on it (#59).
 *
 * LOUD BY DESIGN, and nowhere near `PATCH /api/host/events/{slug}`: this is not
 * one more field on the event form. It re-states every balance on the trip, so
 * it gets its own route, its own confirmation on the screen that calls it, and
 * its own answer — `change` says what it did (the rate used, how many entries
 * moved, how many manual figures were carried through, what landed on
 * `Rounding`) so the page can report it rather than imply it.
 *
 * `owner`/`co_planner` only, which the domain enforces: recording an expense is
 * a participant's job, choosing the basis everyone settles in is not.
 *
 * NO REFUSAL ONCE SETTLING HAS STARTED. A settlement is an entry like any
 * other, so it re-derives with everything else and the nets still clear.
 * Changing the currency halfway through people paying each other back is
 * annoying and gets fixed by peer pressure, not by this route saying no.
 */
const bodySchema = z.object({
  currency: z.string().length(3),
  /**
   * The old → new rate by hand. Omit it and today's is fetched; a fetch that
   * comes back empty is a 422 naming this field, never a recompute at a rate
   * nobody chose.
   */
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional()
}).strict()

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return setEventCurrencyAsPlanner(user.id, slug, body)
})
