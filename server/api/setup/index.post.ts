import { eq, count } from 'drizzle-orm'
import { auth } from '~~/server/utils/auth'
import { db } from '~~/server/utils/db'
import { user } from '~~/server/database/schema'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name: string, email: string, password: string }>(event)

  if (!body?.name || !body?.email || !body?.password) {
    throw createError({ statusCode: 400, statusMessage: 'Name, email, and password are required' })
  }

  // Verify setup has not already been completed
  const [{ count: userCount }] = await db.select({ count: count() }).from(user)
  if (Number(userCount) > 0) {
    throw createError({ statusCode: 403, statusMessage: 'Setup has already been completed' })
  }

  // Create the admin account via better-auth
  const response = await auth.api.signUpEmail({
    body: {
      name: body.name,
      email: body.email,
      password: body.password
    }
  })

  if (!response?.user?.id) {
    throw createError({ statusCode: 500, statusMessage: 'Failed to create admin account' })
  }

  // Promote the newly created user to admin
  await db.update(user).set({ role: 'admin' }).where(eq(user.id, response.user.id))

  return { success: true }
})
