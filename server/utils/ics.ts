import * as icsLib from 'ics'
import type { EventAttributes, DateArray } from 'ics'

/**
 * Thin wrapper around the `ics` package that encapsulates the repeated
 * chore of converting a DB event row into a VEVENT payload and rendering
 * it to a valid `.ics` document.
 *
 * Lives in `server/utils/` rather than `packages/ics/` because this is a
 * single-root Nuxt 4 app.
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

function baseUrl(): string {
  return process.env.BASE_URL || process.env.BETTER_AUTH_URL || ''
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

  const descriptionLines = []
  if (ev.description) descriptionLines.push(ev.description)
  if (ev.ticketUrl) descriptionLines.push(`Tickets: ${ev.ticketUrl}`)
  const url = baseUrl() ? `${baseUrl().replace(/\/$/, '')}/events/${ev.slug}` : undefined
  if (url) descriptionLines.push(url)

  return {
    uid: `${ev.id}@zaeme`,
    title: ev.title,
    description: descriptionLines.join('\n\n') || undefined,
    location: ev.location ?? undefined,
    start: toDateArray(start),
    startInputType: 'utc',
    end: toDateArray(end),
    endInputType: 'utc',
    url,
    productId: 'zaeme/ics',
    calName: 'zäme',
    lastModified: ev.updatedAt
      ? toDateArray(ev.updatedAt instanceof Date ? ev.updatedAt : new Date(ev.updatedAt))
      : undefined
  }
}

/**
 * Render a single event to a standalone `.ics` document. Used as the
 * attachment on RSVP confirmation emails and as the body of the per-event
 * feed (`/events/[slug]/calendar.ics`).
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
 * Render a multi-event `.ics` feed (used by `/calendar/[token].ics`).
 * Silently skips events that lack `startsAt`.
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
