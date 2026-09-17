import { rsvpConfirmed } from './functions/rsvp-confirmed'
import { eventPublished } from './functions/event-published'
import { eventReminder } from './functions/event-reminder'
import { eventCancelled } from './functions/event-cancelled'
import { bringListNudge } from './functions/bring-list-nudge'

export { rsvpConfirmed, eventPublished, eventReminder, eventCancelled, bringListNudge }

/** Everything `/api/inngest` serves. */
export const functions = [
  rsvpConfirmed,
  eventPublished,
  eventReminder,
  eventCancelled,
  bringListNudge
]
