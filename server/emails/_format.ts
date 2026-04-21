/**
 * Formatting helpers shared across email templates. Kept isolated from
 * React so they can be reused by server handlers without pulling JSX into
 * scope.
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

export function resolveBaseUrl(): string {
  return (process.env.BASE_URL || process.env.BETTER_AUTH_URL || '').replace(/\/$/, '')
}

export function absoluteUrl(path: string): string {
  const base = resolveBaseUrl()
  return base ? `${base}${path.startsWith('/') ? path : `/${path}`}` : path
}
