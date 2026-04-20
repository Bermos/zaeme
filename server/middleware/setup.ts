import { db } from '#server/utils/db'
import { user } from '#server/database/schema/auth'

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Don't redirect setup-related or public invite routes to avoid infinite
  // loops / breaking the guest RSVP flow.
  if (
    path.startsWith('/setup')
    || path.startsWith('/api/setup')
    || path.startsWith('/api/auth')
    || path.startsWith('/invite/')
    || path.startsWith('/api/invites/')
  ) {
    return
  }

  const existing = await db.select({ id: user.id }).from(user).limit(1)
  if (existing.length === 0) {
    return sendRedirect(event, '/setup')
  }
})
