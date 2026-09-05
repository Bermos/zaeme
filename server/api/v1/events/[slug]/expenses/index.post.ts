import { z } from 'zod'
import { addExpenseAsPlanner } from '../../../../../domain/index'
import { defineServiceHandler } from '../../../../../utils/service-auth'
import { expense } from '../../../../../utils/v1-shapes'

/**
 * `addTripExpense` — participants without an explicit `amountCents` split the
 * remainder evenly. Money is integer cents throughout.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  category: z.enum(['travel', 'accommodation', 'food', 'tickets', 'other']).optional(),
  amountCents: z.number().int().min(1),
  currency: z.string().min(3).max(3).optional(),
  note: z.string().max(500).optional(),
  paidByName: z.string().min(1).max(200),
  paidByEmail: z.string().email(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email(),
    amountCents: z.number().int().min(0).optional()
  }).strict()).min(1).max(50)
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  // The domain answers the whole budget plus the id it just wrote; the contract
  // answers only that one expense.
  const result = await addExpenseAsPlanner(caller.planner.id, slug, body)
  const recorded = result.expenses.find(e => e.id === result.expenseId)!
  setResponseStatus(event, 201)
  return expense(recorded)
})
