import { getDb, users } from '@zaeme/db'
import { eq } from 'drizzle-orm'
import { auth } from '../../utils/auth'

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const adminEmail = config.adminEmail

  if (!adminEmail) {
    throw createError({ statusCode: 400, message: 'ADMIN_EMAIL is not configured.' })
  }

  const db = getDb(config.databaseUrl)

  // Check that no admin exists yet
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, adminEmail))
    .limit(1)

  if (existing.length > 0) {
    throw createError({ statusCode: 409, message: 'Admin account already exists.' })
  }

  const body = await readBody<{ name: string; password: string }>(event)

  if (!body.name || !body.password) {
    throw createError({ statusCode: 400, message: 'name and password are required.' })
  }

  if (body.password.length < 8) {
    throw createError({ statusCode: 400, message: 'Password must be at least 8 characters.' })
  }

  // Create admin via Better Auth
  const signUpResponse = await auth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: body.password,
      name: body.name,
    },
  })

  // Promote to admin role
  await db
    .update(users)
    .set({ role: 'admin' })
    .where(eq(users.email, adminEmail))

  return { success: true, userId: signUpResponse.user.id }
})
