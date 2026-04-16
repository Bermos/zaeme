import { auth } from './auth'

/**
 * Require an authenticated session on an API route.
 * Throws a 401 if not authenticated.
 */
export async function requireAuth(event: Parameters<typeof auth.api.getSession>[0]) {
  const session = await auth.api.getSession({ headers: event.headers })
  if (!session?.user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return session
}
