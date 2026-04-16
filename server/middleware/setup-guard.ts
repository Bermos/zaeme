import { getDb, users } from '@zaeme/db'
import { eq } from 'drizzle-orm'
import { sendRedirect } from 'h3'

const SETUP_PATH = '/setup'
const SETUP_API_PATH = '/api/setup'
const AUTH_PATHS = ['/api/auth']

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname

  // Allow setup and auth routes through
  if (
    path === SETUP_PATH
    || path.startsWith(SETUP_API_PATH)
    || AUTH_PATHS.some(p => path.startsWith(p))
    || path.startsWith('/_nuxt')
    || path.startsWith('/__nuxt')
    || path === '/favicon.ico'
    || path.startsWith('/api/health')
  ) {
    return
  }

  try {
    const config = useRuntimeConfig()
    const db = getDb(config.databaseUrl)
    const adminEmail = config.adminEmail

    if (!adminEmail) return

    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, adminEmail))
      .limit(1)

    if (admin.length === 0) {
      // No admin yet — redirect to setup
      return sendRedirect(event, SETUP_PATH, 302)
    }
  }
  catch {
    // DB not ready yet (e.g. first boot before migrations) — let through
  }
})
