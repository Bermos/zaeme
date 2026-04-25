import { rsvpConfirmed } from './functions/rsvp-confirmed'
import { eventPublished } from './functions/event-published'
import { eventReminder } from './functions/event-reminder'
import { eventCancelled } from './functions/event-cancelled'
import { datePollClosed } from './functions/datepoll-closed'
import { datePollDecided } from './functions/datepoll-decided'
import { datePollInvite } from './functions/datepoll-invite'

export { rsvpConfirmed } from './functions/rsvp-confirmed'
export { eventPublished } from './functions/event-published'
export { eventReminder } from './functions/event-reminder'
export { eventCancelled } from './functions/event-cancelled'
export { datePollClosed } from './functions/datepoll-closed'
export { datePollDecided } from './functions/datepoll-decided'
export { datePollInvite } from './functions/datepoll-invite'

export const functions = [
  rsvpConfirmed,
  eventPublished,
  eventReminder,
  eventCancelled,
  datePollClosed,
  datePollDecided,
  datePollInvite
]
