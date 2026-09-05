import { guestLoadBudget } from '../../../domain/index'

/** The trip budget refresh for the guest page. */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const budget = await guestLoadBudget(token)
  return { budget }
})
