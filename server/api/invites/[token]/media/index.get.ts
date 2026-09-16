import { z } from 'zod'
import { guestListMedia } from '../../../../domain/index'
import { signMediaItems } from '../../../../utils/media-sign'

/**
 * The invite-holder's media view: the shared gallery (photos/videos), the
 * shared documents (reservations etc.), and EVERY ticket on the event, each
 * marked `mine` or not and labelled with who it is for (#37).
 *
 * `email` IS OPTIONAL AND IS NO LONGER A FILTER. It used to decide which
 * tickets came back; it decides which of them are marked as the caller's. Four
 * friends at a barrier with one working phone between them need the other three
 * tickets off that phone, and an address anybody holding the link can type was
 * never the thing keeping them apart. The owner has said yes to the widening
 * (#37, D2 revised) and it is exactly tickets — `documents` and the gallery are
 * unchanged.
 *
 * THE CREDENTIAL IS THE TOKEN AND NOTHING ELSE: no cookie is read here and no
 * service token, and `test/api-boundary.test.ts` holds that in both directions.
 * What a valid invite RETURNS changed; what counts as a valid invite did not.
 */
const querySchema = z.object({ email: z.string().email().optional() })

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const query = await getValidatedQuery(e, querySchema.parse)

  const { gallery, documents, tickets } = await guestListMedia(token, query.email ?? null)
  const [signedGallery, signedDocuments, signedTickets] = await Promise.all([
    signMediaItems(gallery),
    signMediaItems(documents),
    signMediaItems(tickets)
  ])
  return { gallery: signedGallery, documents: signedDocuments, tickets: signedTickets }
})
