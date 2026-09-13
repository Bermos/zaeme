import { isSetupRequired } from '../../utils/instance'
import { bootstrapConfigured } from '../../utils/passkey-bootstrap'
import { emailConfigured, mailTransport } from '../../utils/mail-status'

/**
 * What a signed-out visitor needs to know to get in. Deliberately open — every
 * field here is about the INSTANCE's configuration, never about an account, a
 * credential or a person.
 *
 * `emailConfigured` is the one that matters most: `/login` uses it to stop
 * offering a magic link on an instance that can deliver nothing, which is how
 * this instance spent its first days — a form that accepted an address, said
 * "check your inbox", and sent the link to a log file.
 *
 * `recoveryAvailable` says a break-glass token is INSTALLED, never what it is.
 * That is what lets `/login` point a locked-out owner at `/setup/recover`
 * instead of leaving them to read the source; an instance with no token says
 * false and the page offers nothing.
 */
export default defineEventHandler(async () => {
  return {
    setupRequired: await isSetupRequired(),
    emailConfigured: emailConfigured(),
    mailTransport: mailTransport(),
    recoveryAvailable: bootstrapConfigured()
  }
})
