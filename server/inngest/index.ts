import { rsvpConfirmed } from './functions/rsvp-confirmed'
import { eventPublished } from './functions/event-published'
import { eventReminder } from './functions/event-reminder'
import { eventCancelled } from './functions/event-cancelled'

export { rsvpConfirmed, eventPublished, eventReminder, eventCancelled }

/** Everything `/api/inngest` serves. */
export const functions = [
  rsvpConfirmed,
  eventPublished,
  eventReminder,
  eventCancelled
]
