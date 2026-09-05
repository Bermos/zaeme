/**
 * The admin surface's UX gate. Owner-only (`server/utils/admin.ts`): a guest
 * session gets 403, not 401, so it is worth telling them apart — signed out
 * goes to /login, signed in as somebody else goes home.
 *
 * Like `guest-auth`, this is NOT the security boundary — every `/api/admin`
 * route re-asks the same question server-side. It only saves the owner from
 * rendering a page that will refuse to fill itself in.
 *
 * `useRequestFetch` rather than `$fetch`: on the SSR pass it forwards the
 * incoming cookies, so the check works on a hard reload of /admin as well as on
 * client-side navigation.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  const request = useRequestFetch()
  try {
    await request('/api/admin/me')
  } catch (err) {
    const status = (err as { status?: number, statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode
    if (status === 403) {
      return navigateTo('/')
    }
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }
})
