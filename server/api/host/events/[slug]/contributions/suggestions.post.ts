import { z } from 'zod'
import { applyBringListSuggestion } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Apply the list the host edited (#45) — the one write this feature has.
 *
 * The body is the PREVIEW AS EDITED, not a "suggest for me" flag, because the
 * issue's list is editable before it is applied: what arrives here is whatever
 * the host left ticked, with whatever counts they typed. Copying a past event
 * lands here too, which is why there is no second route for it — same shape,
 * same duplicate rule, and no field a claim from that event could ride in on.
 *
 * The same bounds as `contributions.post.ts`, because these become ordinary
 * bring-list items the moment they are written and there is no second kind.
 * `max(60)` on the list is the one addition: a suggestion is a handful of lines
 * and a thousand of them is not a bring list.
 */
const bodySchema = z.object({
  items: z.array(z.object({
    title: z.string().min(1).max(200),
    category: z.enum(['food', 'drink', 'other']).optional(),
    quantity: z.string().max(100).optional().nullable(),
    quantityNeeded: z.number().int().min(1).max(10000).optional().nullable(),
    unit: z.string().max(40).optional().nullable(),
    note: z.string().max(500).optional().nullable()
  })).min(1).max(60)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  return applyBringListSuggestion(user.id, slug, body.items)
})
