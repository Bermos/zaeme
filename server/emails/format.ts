import { isRenderableTimezone, zoneDayKey } from '../../shared/utils/timezone'

/**
 * Formatting helpers shared across the email templates. Kept isolated from
 * React so server handlers and background jobs can reuse them without pulling
 * JSX into scope.
 */

/**
 * When the event is, for an email — against the EVENT'S clock when it has one
 * (#31), and stamped with the zone's abbreviation so the reader knows which.
 *
 * AN EMAIL IS THE SURFACE THAT NEEDS THE LABEL MOST. Every screen that shows a
 * time now says which clock it is using; a mail lands in an inbox with no card
 * around it, is read days later and on another continent, and is the thing
 * people act on. Before this it stated the start in whatever zone the SERVER's
 * container happened to be set to, unlabelled — so the invite email for a
 * Lisbon trip said 08:14 while the invite page it links to said 09:14 WEST.
 * That was not a regression this issue introduced; it is the same class of
 * surface as the `.ics` feeds, and those were checked, so this is too.
 *
 * ⚠️ `dateStyle`/`timeStyle` AND `timeZoneName` CANNOT BE COMBINED — `Intl`
 * throws `TypeError: Invalid option : option`, not silently ignoring it. Hence
 * two formatters and a join rather than one option bag.
 *
 * The abbreviation is taken at the START's own instant, never applied to the
 * span: a trip across the last Sunday in October is half `WEST` and half `WET`.
 */
export function formatEventWhen(
  startsAt: Date | string | null,
  endsAt: Date | string | null,
  timezone?: string | null
): string | null {
  if (!startsAt) return null
  const start = startsAt instanceof Date ? startsAt : new Date(startsAt)
  const zone = isRenderableTimezone(timezone) ? timezone : undefined
  const full = (d: Date) => d.toLocaleString('en-CH', { dateStyle: 'long', timeStyle: 'short', timeZone: zone })
  const startStr = full(start)
  const stamp = zone
    ? new Intl.DateTimeFormat('en-CH', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(start).find(part => part.type === 'timeZoneName')?.value ?? null
    : null

  if (!endsAt) return stamp ? `${startStr} ${stamp}` : startStr
  const end = endsAt instanceof Date ? endsAt : new Date(endsAt)
  // Same day IN THE EVENT'S ZONE. On the server's own calendar a 23:30 Lisbon
  // finish is already tomorrow in Auckland, and the line would repeat the date
  // for a party that did not span one.
  const sameDay = zoneDayKey(start, zone ?? null) === zoneDayKey(end, zone ?? null)
  const endStr = sameDay
    ? end.toLocaleTimeString('en-CH', { hour: '2-digit', minute: '2-digit', timeZone: zone })
    : full(end)
  const span = `${startStr} – ${endStr}`
  return stamp ? `${span} ${stamp}` : span
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
