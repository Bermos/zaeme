/**
 * The small formatting the admin surface repeats on every page. Auto-imported
 * (`app/utils`), the same way `auth-client` is.
 */

/** A date, the way this app says dates everywhere else. */
export function formatWhen(value: string | Date | null | undefined, opts: { time?: boolean } = {}): string {
  if (!value) return '—'
  const d = new Date(value)
  return opts.time === false
    ? d.toLocaleDateString('en-CH', { dateStyle: 'medium' })
    : d.toLocaleString('en-CH', { dateStyle: 'medium', timeStyle: 'short' })
}

/** Relative, for a log: "3 min ago". Falls back to the date past a week. */
export function formatAgo(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const then = new Date(value).getTime()
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} d ago`
  return formatWhen(value, { time: false })
}

/** Bytes, in the unit a human would say them in. */
export function formatBytes(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0)
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** The status badge colour used on every list of events. */
export function eventStatusColor(status: string): 'neutral' | 'warning' | 'success' | 'error' | 'info' {
  return ({
    draft: 'neutral',
    polling: 'warning',
    published: 'success',
    completed: 'info',
    cancelled: 'error'
  } as const)[status] ?? 'neutral'
}

/** The emoji this app has always used for an event type. */
export const EVENT_TYPE_LABEL: Record<string, string> = {
  hosted: '🎬 gathering',
  party: '🥳 party',
  trip: '🧳 trip',
  series: '🍿 series',
  concert: '🎤 concert'
}
