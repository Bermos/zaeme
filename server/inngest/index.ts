import { rsvpConfirmed } from './functions/rsvp-confirmed'
import { eventPublished } from './functions/event-published'
import { eventReminder } from './functions/event-reminder'
import { eventCancelled } from './functions/event-cancelled'

export { rsvpConfirmed } from './functions/rsvp-confirmed'
export { eventPublished } from './functions/event-published'
export { eventReminder } from './functions/event-reminder'
export { eventCancelled } from './functions/event-cancelled'

export const functions = [
  rsvpConfirmed,
  eventPublished,
  eventReminder,
  eventCancelled
]
