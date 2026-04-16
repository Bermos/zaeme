import { db } from '../../utils/db'
import { user } from '../../database/schema/auth'

export default defineEventHandler(async () => {
  const adminUsers = await db
    .select({ id: user.id })
    .from(user)
    .limit(1)

  return { setupRequired: adminUsers.length === 0 }
})
