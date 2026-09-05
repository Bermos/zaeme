import { z } from 'zod'
import { addContribution, assertPlanner, loadEventBySlug } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'

/** The host adds a bring-list item guests can claim (planner only). */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['food', 'drink', 'other']).optional(),
  quantity: z.string().max(100).optional().nullable(),
  note: z.string().max(500).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, user.id, { roles: ['owner', 'co_planner'] })

  const item = await addContribution(ev.id, body, { userId: user.id })
  return { contribution: item }
})
