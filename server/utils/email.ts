import { Resend } from 'resend'

/**
 * Thin wrapper around Resend. Keeps three promises:
 *
 * 1. Graceful degradation — when `RESEND_API_KEY` is absent the helper
 *    logs the email payload and resolves successfully. This keeps the
 *    request path (RSVP, magic-link, …) working in dev and on
 *    self-hosted instances that have not yet configured email.
 *
 * 2. One client per process. Resend creates a persistent `fetch` instance
 *    so we cache the client.
 *
 * 3. A predictable From address. Resolves from `EMAIL_FROM`, else falls
 *    back to the well-known Resend onboarding address which only works
 *    for verified domains — effectively forcing misconfigured installs
 *    into dry-run mode.
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

export async function sendEmail(opts: SendEmailOptions): Promise<SendEmailResult> {
  const client = getResend()

  if (!client) {
    // Dry-run: log the payload so self-hosters can verify content in dev.
    console.log('[email:dry-run]', {
      tag: opts.tag,
      to: opts.to,
      subject: opts.subject,
      preview: opts.text?.slice(0, 200) ?? opts.html.slice(0, 200)
    })
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
    throw createError({ statusCode: 502, message: `Email delivery failed: ${error.message}` })
  }

  return { sent: true, id: data?.id }
}
