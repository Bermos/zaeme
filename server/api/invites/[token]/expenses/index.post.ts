import { z } from 'zod'
import { guestAddExpense } from '../../../../domain/index'

/** A trip participant records an expense via their invite link. */
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
  })).min(1).max(50),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { guestName, guestEmail, ...input } = await readValidatedBody(e, bodySchema.parse)
  const budget = await guestAddExpense(token, input, { guestName, guestEmail })
  return { budget }
})
