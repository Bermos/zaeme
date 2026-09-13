/**
 * Can this instance actually deliver an email?
 *
 * It is asked by `/api/setup/status`, which is how the sign-in page knows
 * whether to offer a magic link at all. Offering one on an instance with no
 * transport is the worst version of this bug: the form accepts the address,
 * says "check your inbox", and nothing ever arrives — indistinguishable, from
 * the outside, from a link that went to spam.
 *
 * Two transports, in the order `server/emails/send.ts` picks them:
 *
 *  - the **mail relay** — an HTTP endpoint on this platform in front of Proton
 *    Bridge (`kitchen-services`), bound in as `KITCHEN_SERVICE_MAIL`;
 *  - **Resend**, for an instance that has an API key.
 *
 * Neither, and outgoing mail is a dry run written to the log.
 */
export type MailTransport = 'relay' | 'resend' | 'dry-run'

/** The relay's base URL — its own variable first, then the Kitchen binding. */
export function mailRelayUrl(): string | null {
  return process.env.MAIL_RELAY_URL || process.env.KITCHEN_SERVICE_MAIL || null
}

/** Which transport a message sent right now would take. */
export function mailTransport(): MailTransport {
  if (mailRelayUrl() && process.env.MAIL_RELAY_TOKEN) return 'relay'
  if (process.env.RESEND_API_KEY) return 'resend'
  return 'dry-run'
}

/** Will a magic link reach the address somebody types into the sign-in form? */
export function emailConfigured(): boolean {
  return mailTransport() !== 'dry-run'
}
