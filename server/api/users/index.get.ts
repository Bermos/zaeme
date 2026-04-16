import { db } from '../../utils/db'
import { requireAuth } from '../../utils/session'
import { user } from '../../database/schema/auth'

export default defineEventHandler(async (e) => {
  await requireAuth(e)

  const users = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)

  return users
})
