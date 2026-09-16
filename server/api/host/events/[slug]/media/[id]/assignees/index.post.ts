import { z } from 'zod'
import { addTicketAssignee } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Add one attendee to a ticket (#36).
 *
 * A COLLECTION WITH TWO VERBS, which is what replaced the single
 * `POST …/media/{id}/assign` that SET the one attendee a ticket could have.
 * That route could not express "and also Ben" — passing a second rsvpId took
 * the ticket away from the first person — so it is gone rather than kept as a
 * third way to say the same thing.
 *
 * Idempotent: adding somebody already on the ticket answers 200 with the ticket
 * as it stands, because that is the state the caller asked for.
 *
 * The reply is the whole media item, assignees and detail included — and the
 * one screen that posts here DISCARDS IT and re-fetches, which is worth saying
 * rather than leaving as an apparent oversight. `HostMediaCard` renders a
 * DOWNLOAD, so its items carry a signed `url`; the domain answers a
 * `MediaItemView`, which carries a `storageKey` and is signed on the way out by
 * whichever handler lists media (`signMediaItems`). Signing one item here to
 * spare that card a round trip would put a presigner behind a mutation, which
 * is not what this route is for. So the body is for a caller that wants the new
 * state without a second read and does not need the bytes — and the card, which
 * does, refreshes.
 */
const bodySchema = z.object({ rsvpId: z.string().min(1).max(50) })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await addTicketAssignee(user.id, slug, id, body.rsvpId)
  return { media }
})
