import { db } from '../utils/db'
import { user } from '../database/schema/auth'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Don't redirect setup-related routes to avoid infinite loops
  if (path.startsWith('/setup') || path.startsWith('/api/setup') || path.startsWith('/api/auth')) {
    return
  }

  const existing = await db.select({ id: user.id }).from(user).limit(1)
  if (existing.length === 0) {
    return sendRedirect(event, '/setup')
  }
})
