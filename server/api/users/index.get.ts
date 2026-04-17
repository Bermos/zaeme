import { db } from '#server/utils/db'
import { requireAuth } from '#server/utils/session'
import { user } from '#server/database/schema/auth'

export default defineEventHandler(async (e) => {
  await requireAuth(e)

  return db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
})
