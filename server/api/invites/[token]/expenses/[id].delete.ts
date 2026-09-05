import { z } from 'zod'
import { guestRemoveExpense } from '../../../../domain/index'

/** Remove an expense you recorded or paid (planner removal is on the host side). */
const querySchema = z.object({ email: z.string().email() })

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const id = getRouterParam(e, 'id')!
  const query = await getValidatedQuery(e, querySchema.parse)
  const budget = await guestRemoveExpense(token, id, query.email)
  return { budget }
})
