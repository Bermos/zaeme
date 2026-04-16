import type { H3Event } from 'h3'
import { auth } from './auth'

/**
 * Require an authenticated session on an API route.
 * Throws a 401 if not authenticated.
 */
export async function requireAuth(event: H3Event) {
  const session = await auth.api.getSession({ headers: toWebRequest(event).headers })
  if (!session?.user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return session
}
