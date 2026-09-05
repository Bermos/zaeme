import { Inngest, eventType, staticSchema } from 'inngest'

/**
 * zäme's Inngest client and its event vocabulary — the app's own nervous
 * system again. While zäme lived in the Enterprise monorepo it only *sent*
 * these signals and a department layer over there held the handlers; both
 * halves are back in this repo (see ./functions/).
 *
 * Each `eventType` is used both as the trigger on a function and as a
 * type-safe factory for `inngest.send()`. `staticSchema` gives compile-time
 * types without a runtime validator — the API boundary already validates with
 * Zod. The `events/` prefix is kept from the monorepo era so no persisted
 * scheduled run (the 48h reminder is sent with a future `ts`) is orphaned.
 */

export const RsvpConfirmedEvent = eventType('events/rsvp.confirmed', {
  schema: staticSchema<{
    rsvpId: string
    eventId: string
    userId?: string | null
    guestEmail?: string | null
  }>()
})

export const EventPublishedEvent = eventType('events/event.published', {
  schema: staticSchema<{ eventId: string }>()
})

export const EventReminderEvent = eventType('events/event.reminder', {
  schema: staticSchema<{ eventId: string }>()
})

export const EventCancelledEvent = eventType('events/event.cancelled', {
  schema: staticSchema<{ eventId: string, reason?: string | null }>()
})

export const inngest = new Inngest({
  id: 'zaeme',
  eventKey: process.env.INNGEST_EVENT_KEY,
  // Forces the in-process dev server when no cloud key is configured.
  isDev: !process.env.INNGEST_EVENT_KEY
})
