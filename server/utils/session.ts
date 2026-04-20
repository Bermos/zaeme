import { auth } from './auth'
import type { H3Event } from 'h3'

/**
 * Require an authenticated session on an API route.
 * Throws a 401 if not authenticated.
 */
export async function requireAuth(event: H3Event) {
  const session = await auth.api.getSession({
    headers: event.headers
  })

  if (!session?.user) {
    throw createError({ statusCode: 401, message: 'Unauthorized' })
  }
  return session
}

/**
 * Return the current session if present, otherwise null. Used by
 * routes that accept both guest-token and authenticated access.
 */
export async function optionalAuth(event: H3Event) {
  const session = await auth.api.getSession({
    headers: event.headers
  })
  return session?.user ? session : null
}
