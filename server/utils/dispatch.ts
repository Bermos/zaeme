import { inngest } from '../inngest/client'
import type { EventDispatch } from '../domain/events-data'

/**
 * Fire-and-forget signal delivery — the `EventDispatch` the domain takes as an
 * injected dependency (it stays Inngest-agnostic). Background job delivery must
 * never break the user-visible request: if Inngest is unreachable we log and
 * move on, and the RSVP is still saved.
 */
export const dispatchEvent: EventDispatch = async (name, data) => {
  try {
    await inngest.send({ name, data })
  } catch (err) {
    console.error('[zaeme:dispatch]', { name, err })
  }
}
