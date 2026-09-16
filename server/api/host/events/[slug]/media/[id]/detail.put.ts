import { z } from 'zod'
import { setTicketDetail } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * What is printed on a ticket (#35) — the booking reference, the coach and the
 * seat, so a barrier can be read without waiting for a PDF to render.
 *
 * HOST-MANAGED, like the upload, the assignment and the delete beside it. A
 * ticket belongs to one attendee and says where they are sitting;
 * `server/domain/guest.ts` refuses a guest even the upload, and this issue
 * changes none of that.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS NULLABLE, and the schema is the
 * first place that has to say so: a ticket with nothing filled in is still a
 * ticket, and the moment one of these gains a `.min(1)` the upload becomes a
 * form somebody has to complete. `{}` is a valid body and clears the lot.
 *
 * PUT rather than PATCH because the write REPLACES (see `setTicketDetail`):
 * absent means cleared, which is one meaning per request rather than the
 * three-way absent/null/value distinction a form cannot express anyway.
 */
const bodySchema = z.object({
  bookingRef: z.string().max(100).nullish(),
  carrier: z.string().max(200).nullish(),
  seat: z.string().max(50).nullish(),
  coach: z.string().max(50).nullish(),
  travellerName: z.string().max(200).nullish(),
  // An INSTANT with an offset, not a wall clock. The host form reads its
  // `datetime-local` fields against the event's zone with `isoFromZonedInput`
  // (#31) before sending, so what arrives here is unambiguous.
  validFrom: z.iso.datetime({ offset: true }).nullish(),
  validUntil: z.iso.datetime({ offset: true }).nullish(),
  note: z.string().max(2000).nullish()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await setTicketDetail(user.id, slug, id, body)
  return { media }
})
