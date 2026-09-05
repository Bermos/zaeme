import { z } from 'zod'
import { guestAddContribution } from '../../../../domain/index'

/** A guest adds a bring-list item (optionally claiming it right away). */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['food', 'drink', 'other']).optional(),
  quantity: z.string().max(100).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
  claim: z.boolean().optional().default(true),
  guestName: z.string().min(1).max(200),
  guestEmail: z.string().email()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const item = await guestAddContribution(
    token,
    { title: body.title, category: body.category, quantity: body.quantity, note: body.note, claim: body.claim },
    { guestName: body.guestName, guestEmail: body.guestEmail }
  )
  return { contribution: item }
})
