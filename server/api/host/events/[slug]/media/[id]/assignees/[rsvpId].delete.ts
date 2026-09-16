import { removeTicketAssignee } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Take one attendee off a ticket (#36) — and leave the others on it, which is
 * the whole difference from the `assignedRsvpId` this replaces, where the only
 * "remove" there was meant "nobody has this ticket now".
 *
 * The rsvpId is in the PATH and not in a body: this deletes one element of a
 * collection, DELETE bodies are the one part of HTTP every layer between here
 * and a browser feels free to drop, and a delete that silently arrives with no
 * rsvpId would be a request to remove nobody.
 *
 * Idempotent: removing somebody who is not on the ticket answers 200 with the
 * ticket as it stands. The reply is the whole media item, and the host card
 * discards it and re-fetches — for the reason spelled out on the add beside
 * this one, which is that the card needs a signed download URL and a domain
 * view does not carry one.
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const rsvpId = getRouterParam(e, 'rsvpId')!
  const media = await removeTicketAssignee(user.id, slug, id, rsvpId)
  return { media }
})
