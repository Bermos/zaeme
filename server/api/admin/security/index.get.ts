import { requireOwner } from '../../../utils/admin'
import { listPasskeysForUser } from '../../../domain/passkeys'
import { bootstrapConfigured } from '../../../utils/passkey-bootstrap'
import { emailConfigured, mailTransport } from '../../../utils/mail-status'

/**
 * How the owner gets in, and what would happen if one of those ways stopped
 * working. One page for the whole question rather than three places to look.
 *
 * `bootstrapInstalled` is the one worth acting on: the break-glass token is
 * meant to be removed once a passkey exists, and an instance that leaves it set
 * has a standing second door. The page says so; this is where it learns it.
 */
export default defineEventHandler(async (e) => {
  const owner = await requireOwner(e)
  return {
    passkeys: await listPasskeysForUser(owner.id),
    emailConfigured: emailConfigured(),
    mailTransport: mailTransport(),
    bootstrapInstalled: bootstrapConfigured()
  }
})
