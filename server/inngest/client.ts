import { Inngest, eventType, staticSchema } from 'inngest'

/**
 * Centralised event definitions. Each `eventType` is used both as the
 * trigger on a function (`inngest.createFunction({ triggers: [{ event: Foo }] }, …)`)
 * and as a type-safe factory for `inngest.send()` calls.
 *
 * `staticSchema` provides compile-time types without pulling in a runtime
 * validator — we already validate at the API boundary with Zod.
 */

export const RsvpConfirmedEvent = eventType('rsvp.confirmed', {
  schema: staticSchema<{
    rsvpId: string
    eventId: string
    userId?: string | null
    guestEmail?: string | null
  }>()
})

export const EventPublishedEvent = eventType('event.published', {
  schema: staticSchema<{ eventId: string }>()
})

export const EventReminderEvent = eventType('event.reminder', {
  schema: staticSchema<{ eventId: string }>()
})

export const EventCancelledEvent = eventType('event.cancelled', {
  schema: staticSchema<{ eventId: string, reason?: string | null }>()
})

/**
 * Auto-close a date poll. Scheduled with a future `ts` matching the
 * poll's deadline. The handler no-ops if the poll has already been
 * decided manually.
 */
export const DatePollClosedEvent = eventType('datepoll.closed', {
  schema: staticSchema<{ pollId: string }>()
})

/**
 * Fan out the "the date is set" notification with a fresh `.ics`. Fired
 * by the `/poll/decide` route once the planner picks a slot.
 */
export const DatePollDecidedEvent = eventType('datepoll.decided', {
  schema: staticSchema<{ pollId: string, eventId: string }>()
})

/**
 * Send poll-invite emails to every targeted invite on the event. Fired
 * once the planner publishes the poll.
 */
export const DatePollInviteEvent = eventType('datepoll.invite', {
  schema: staticSchema<{ eventId: string }>()
})

export const inngest = new Inngest({
  id: 'zaeme',
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Forces the in-process dev server when no cloud key is configured.
  isDev: !process.env.INNGEST_EVENT_KEY
})

/**
 * Fire-and-forget wrapper that never throws. Background job delivery must
 * not break the user-visible request flow — if Inngest is unreachable we
 * log and move on.
 */
export async function dispatch(
  name: 'rsvp.confirmed' | 'event.published' | 'event.reminder' | 'event.cancelled' | 'datepoll.closed' | 'datepoll.decided' | 'datepoll.invite',
  data: Record<string, unknown>,
  options?: { ts?: number }
): Promise<void> {
  try {
    await inngest.send({ name, data, ts: options?.ts })
  } catch (err) {
    console.error('[inngest:dispatch]', { name, err })
  }
}
