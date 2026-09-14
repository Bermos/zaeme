import { z } from 'zod'
import { addExpenseAsPlanner } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'

/** Record an expense as the host (owner/co-planner only). */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['travel', 'accommodation', 'food', 'tickets', 'other']).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  // The manual override (#25). Present means "do not fetch a rate" — which is
  // both the correction of a wrong one and the only way in on an instance with
  // no outbound network.
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  note: z.string().max(500).optional().nullable(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.string().email(),
  // How the total is divided (#26). Omitted means `even`, which is what every
  // expense recorded before this field existed did.
  splitMode: z.enum(['even', 'exact', 'percentage', 'weight']).optional(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    amountCents: z.number().int().min(0).optional(),
    // The percentage or the share count as entered, for those two modes.
    weight: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional()
  })).min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await addExpenseAsPlanner(user.id, slug, body)
  return { budget }
})
