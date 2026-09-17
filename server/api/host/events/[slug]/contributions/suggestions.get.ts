import { z } from 'zod'
import { listBringListSources, suggestBringList } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * The editable preview behind "suggest a list" (#45) — nothing is written here.
 *
 * `?from=<slug>` copies another event of the same type this host has already
 * run, instead of scaling the checked-in set to the yes-RSVPs. `sources` is
 * what that select is populated from, and it is returned on every read so the
 * screen needs one request rather than two.
 */
const querySchema = z.object({ from: z.string().max(200).optional() })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const { from } = await getValidatedQuery(e, querySchema.parse)

  const [suggestion, sources] = await Promise.all([
    suggestBringList(user.id, slug, { from }),
    listBringListSources(user.id, slug)
  ])
  return { suggestion, sources }
})
