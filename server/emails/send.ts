import { Resend } from 'resend'
import { relayConfigured, sendViaRelay } from './relay'

/**
 * Everything zäme sends leaves through here. Three transports, tried in this
 * order, and the order is the whole design:
 *
 * 1. **The mail relay** (`relay.ts`) — Proton Bridge running as its own
 *    workload on this platform, reached at the address the platform handed us.
 *    This is what a self-hosted instance uses, and it is first because an
 *    instance that has one has deliberately built it.
 * 2. **Resend**, for an instance that has an API key instead.
 * 3. **A dry run** — the payload, and every link in it, on stdout. Not a
 *    failure: the request path keeps working in dev and on an instance whose
 *    mail is not configured yet, and the printed magic link is how such an
 *    instance is bootstrapped at all.
 *
 * Beside that it keeps two promises it always kept: one Resend client per
 * process (it creates a persistent `fetch`), and a predictable `From` address.
 */

let resendClient: Resend | null = null
let resendResolved = false

function getResend(): Resend | null {
  if (resendResolved) return resendClient
  resendResolved = true
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return null
  resendClient = new Resend(apiKey)
  return resendClient
}

function getFromAddress(): string {
  return process.env.EMAIL_FROM || 'zäme <onboarding@resend.dev>'
}

export interface SendEmailOptions {
  to: string | string[]
  subject: string
  html: string
  text?: string
  /** Reply-to address. Defaults to the `From` address. */
  replyTo?: string
  /** Optional attachments (e.g. `.ics` files on RSVP confirmations). */
  attachments?: {
    filename: string
    content: string | Buffer
    contentType?: string
  }[]
  /** Opaque tag used for delivery logs. */
  tag?: string
}

export interface SendEmailResult {
  /** `true` when the email was dispatched. `false` in dry-run mode. */
  sent: boolean
  /** Resend message id when `sent`. */
  id?: string
}

/**
 * Every absolute URL in a message, whole.
 *
 * The dry-run log used to be `text.slice(0, 200)`, and a magic-link email is
 * longer than that — so the one line a self-hoster actually needs was cut
 * through the middle of the token. Clicking the truncated link fails
 * verification and lands back on `/setup`, which looks exactly like the click
 * did nothing. First-run bootstrap on an instance with no email configured was
 * therefore impossible, which is the one case the dry-run exists for.
 *
 * Read out of the text part rather than the HTML: an `href` carries `&amp;`
 * for every `&`, so a URL copied out of the markup loses its query string.
 * Trailing punctuation is trimmed because a URL at the end of a sentence
 * otherwise swallows the full stop.
 */
export function linksIn(message: string): string[] {
  const found = message.match(/https?:\/\/[^\s<>"')]+/g) ?? []
  return [...new Set(found.map(url => url.replace(/[.,;:!?]+$/, '')))]
}

/**
 * What the dry-run prints. Split out from `sendEmail` so it can be tested
 * without capturing stdout — the truncation bug above shipped precisely
 * because nothing asserted on this shape.
 */
export function dryRunPayload(opts: SendEmailOptions) {
  const body = opts.text ?? opts.html
  return {
    tag: opts.tag,
    to: opts.to,
    subject: opts.subject,
    // Whole, never sliced: this is what the reader has to be able to click.
    links: linksIn(body),
    preview: body.slice(0, 200)
  }
}

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  if (relayConfigured()) {
    return sendViaRelay(opts, getFromAddress())
  }

  const client = getResend()

  if (!client) {
    console.log('[email:dry-run]', dryRunPayload(opts))
    return { sent: false }
  }

  const attachments = opts.attachments?.map(a => ({
    filename: a.filename,
    content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
    contentType: a.contentType
  }))

  const { data, error } = await client.emails.send({
    from: getFromAddress(),
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo,
    attachments,
    tags: opts.tag ? [{ name: 'kind', value: opts.tag }] : undefined
  })

  if (error) {
    console.error('[email:send]', { tag: opts.tag, error })
    throw new Error(`Email delivery failed: ${error.message}`)
  }

  return { sent: true, id: data?.id }
}
