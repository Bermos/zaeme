import { db } from '#server/utils/db'
import { user } from '#server/database/schema'

export default defineEventHandler(async () => {
  const adminUsers = await db
    .select({ id: user.id })
    .from(user)
    .limit(1)

  return { setupRequired: adminUsers.length === 0 }
})
