/**
 * Session gate for the account-only pages (/me, /host/**) — NOT global: guest
 * links must stay open (ADR-0019 §3). Client-side check; the APIs behind these
 * pages 401 independently, so this is UX, not the security boundary.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return
  const { authClient } = await import('../utils/auth-client')
  const { data: session } = await authClient.getSession()
  if (!session) {
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
