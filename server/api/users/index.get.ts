import { useDb } from '../../utils/db'
import { guestUser } from '../../database/schema/auth'
import { requireGuestUser } from '../../utils/auth'

/**
 * The accounts on this instance — name and email only. Used by the host
 * surface to name a co-organizer. Session-gated: an anonymous guest holding an
 * invite link has no business enumerating the address book.
 */
export default defineEventHandler(async (e) => {
  await requireGuestUser(e)

  return useDb()
    .select({ id: guestUser.id, name: guestUser.name, email: guestUser.email })
    .from(guestUser)
})
