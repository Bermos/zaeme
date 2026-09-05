import { z } from 'zod'
import { guestListMedia } from '../../../../domain/index'
import { signMediaItems } from '../../../../utils/media-sign'

/**
 * The invite-holder's media view: the shared gallery (photos/videos), the
 * shared documents (reservations etc.), and — matched via their email — their
 * own tickets. Pass `email` (the guest identity) to surface the tickets.
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
