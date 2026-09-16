import * as icsLib from 'ics'
import type { EventAttributes, DateArray } from 'ics'

/**
 * Calendar/ICS generation: a thin wrapper around the `ics` package that turns
 * an event into a VEVENT payload and renders a valid `.ics` document.
 *
 * Deliberately domain-light — it speaks `IcsEventInput`, not the `events_*`
 * schema — so the routes and the confirmation-email job both map onto it
 * rather than this file reaching into the database.
 *
 * ── AND WHY #31'S DISPLAY ZONE IS NOT HERE ────────────────────────────────
 *
 * #31 gave `events_event` a `timezone`, and asked that these feeds be checked
 * and left alone if they were already right. They were. Every `DTSTART` this
 * file emits is form 2 of RFC 5545 §3.3.5 — `20260701T081400Z`, an absolute
 * UTC instant — because `startInputType: 'utc'` is paired with a UTC date
 * array. An instant is unambiguous, needs no `VTIMEZONE`, and every calendar
 * client already renders it against the clock of whoever is reading, which is
 * what a calendar is for and is the one place the phone's zone is the right
 * answer.
 *
 * The alternative is `DTSTART;TZID=Europe/Lisbon:20260701T091400`, and it is
 * worse in both directions: it names the same moment, so nothing on anybody's
 * screen improves, and RFC 5545 §3.2.19 requires a matching `VTIMEZONE`
 * component in the same iCalendar object — which the `ics` package does not
 * emit. Adding the parameter without it would produce a document that is
 * invalid, and that a strict client is entitled to reject: a feed that stops
 * working, to change nothing. So the zone is a zäme-screen concern and this
 * file carries no knowledge of it.
 */

export interface IcsEventInput {
  id: string
  slug: string
  title: string
  description: string | null
  startsAt: Date | string | null
  endsAt: Date | string | null
  location: string | null
  ticketUrl: string | null
  updatedAt?: Date | string | null
}

function toDateArray(d: Date): DateArray {
  return [
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes()
  ]
}

/**
 * Public base URL for event links embedded in the calendar entry. Only an
 * absolute http(s) URL is used — the `ics` library rejects relative URLs, and
 * some bundlers set `BASE_URL` to a path like "/", which must be ignored.
 */
function baseUrl(): string {
  const candidate = process.env.BASE_URL || process.env.BETTER_AUTH_URL || process.env.KITCHEN_URL || ''
  return /^https?:\/\//.test(candidate) ? candidate : ''
}

/**
 * Build an `ics.EventAttributes` object from an event row. Returns `null`
 * when the event has no `startsAt` (cannot be represented in a calendar).
 */
export function eventToIcsAttributes(ev: IcsEventInput): EventAttributes | null {
  if (!ev.startsAt) return null

  const start = ev.startsAt instanceof Date ? ev.startsAt : new Date(ev.startsAt)
  const end = ev.endsAt
    ? (ev.endsAt instanceof Date ? ev.endsAt : new Date(ev.endsAt))
    : new Date(start.getTime() + 2 * 60 * 60 * 1000) // default 2h

  const descriptionLines: string[] = []
  if (ev.description) descriptionLines.push(ev.description)
  if (ev.ticketUrl) descriptionLines.push(`Tickets: ${ev.ticketUrl}`)
  const url = baseUrl() ? `${baseUrl().replace(/\/$/, '')}/e/${ev.slug}` : undefined
  if (url) descriptionLines.push(url)

  return {
    uid: `${ev.id}@zame`,
    title: ev.title,
    description: descriptionLines.join('\n\n') || undefined,
    location: ev.location ?? undefined,
    start: toDateArray(start),
    startInputType: 'utc',
    end: toDateArray(end),
    endInputType: 'utc',
    url,
    productId: 'zame/ics',
    calName: 'zäme',
    lastModified: ev.updatedAt
      ? toDateArray(ev.updatedAt instanceof Date ? ev.updatedAt : new Date(ev.updatedAt))
      : undefined
  }
}

/**
 * Render a single event to a standalone `.ics` document. Used as the attachment
 * on RSVP confirmation emails and as the body of the per-event feed.
 */
export function renderEventIcs(ev: IcsEventInput): string {
  const attrs = eventToIcsAttributes(ev)
  if (!attrs) {
    throw new Error('Cannot render ICS for event without startsAt')
  }
  const { error, value } = icsLib.createEvent(attrs)
  if (error || !value) {
    throw error ?? new Error('Failed to render ICS')
  }
  return value
}

/**
 * Render a multi-event `.ics` feed (used by the attendee calendar feed). Silently
 * skips events that lack `startsAt`.
 */
export function renderFeedIcs(events: IcsEventInput[]): string {
  const attrsList = events
    .map(eventToIcsAttributes)
    .filter((a): a is EventAttributes => a !== null)

  const { error, value } = icsLib.createEvents(attrsList)
  if (error || !value) {
    throw error ?? new Error('Failed to render ICS feed')
  }
  return value
}
