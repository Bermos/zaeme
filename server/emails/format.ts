/**
 * Formatting helpers shared across the email templates. Kept isolated from
 * React so server handlers and background jobs can reuse them without pulling
 * JSX into scope.
 */

export function formatEventWhen(startsAt: Date | string | null, endsAt: Date | string | null): string | null {
  if (!startsAt) return null
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt)
  const startStr = start.toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' })
  if (!endsAt) return startStr
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt)
  const sameDay = start.toDateString() === end.toDateString()
  const endStr = sameDay
    ? end.toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit' })
    : end.toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short' })
  return `${startStr} – ${endStr}`
}

/**
 * Where this deployment is published. `KITCHEN_URL` is the platform's answer
 * and the last resort on purpose: a preview environment's hostname carries a
 * pull-request number nothing in this repository has ever heard of, so it is
 * the only way an invite link in a preview can point at that preview.
 */
export function resolveBaseUrl(): string {
  return (
    process.env.BASE_URL
    || process.env.BETTER_AUTH_URL
    || process.env.KITCHEN_URL
    || ''
  ).replace(/\/$/, '')
}

export function absoluteUrl(path: string): string {
  const base = resolveBaseUrl()
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path
}

/**
 * Where GUEST-facing links (invite pages `/i/{token}`, calendar feeds) point.
 * That is this app now that zäme is standalone again, so `PUBLIC_SITE_URL` is
 * an override rather than a requirement and this falls through to the app's
 * own base URL.
 */
export function resolvePublicSiteUrl(): string {
  return (process.env.PUBLIC_SITE_URL || '').replace(/\/$/, '') || resolveBaseUrl()
}

export function publicSiteUrl(path: string): string {
  const base = resolvePublicSiteUrl()
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path
}
