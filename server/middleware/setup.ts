import { isSetupRequired } from '../utils/instance'

/**
 * First-run bootstrap. Until somebody has claimed this instance, every surface
 * that would need an account redirects to `/setup`.
 *
 * The exclusions matter more than the redirect: a guest holding an invite link
 * is the app's primary visitor and must never be bounced into an admin flow, so
 * the whole capability surface (`/i/…`, `/e/…`, the public listing, the
 * calendar feeds) and the machine endpoints (auth, health, Inngest) are exempt.
 */
const EXEMPT_PREFIXES = [
  '/setup',
  '/healthz',
  '/api/setup',
  '/api/auth',
  '/api/inngest',
  '/api/health',
  // The machine surface authenticates itself and must never be redirected into
  // a browser bootstrap flow; nor must the contract it publishes.
  '/api/v1/',
  '/api/openapi.yaml',
  '/api/public/',
  '/api/invites/',
  '/i/',
  '/e/',
  '/concerts',
  '/calendar/',
  '/login'
]

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  if (EXEMPT_PREFIXES.some(p => path === p || path.startsWith(p))) return
  // Nuxt's own build output and any static asset.
  if (path.startsWith('/_')) return

  if (await isSetupRequired()) {
    return sendRedirect(event, '/setup')
  }
})
