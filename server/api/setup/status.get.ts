import { count } from 'drizzle-orm'
import { db } from '~~/server/utils/db'
import { user } from '~~/server/database/schema'

export default defineEventHandler(async () => {
  const [{ count: userCount }] = await db.select({ count: count() }).from(user)
  return { completed: Number(userCount) > 0 }
})
