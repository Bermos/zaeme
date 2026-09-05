import { z } from 'zod'
import { addExpenseAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Record an expense as the host (owner/co-planner only). */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['travel', 'accommodation', 'food', 'tickets', 'other']).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  note: z.string().max(500).optional().nullable(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.string().email(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    amountCents: z.number().int().min(0).optional()
  })).min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await addExpenseAsPlanner(user.id, slug, body)
  return { budget }
})
