import { mailRelayUrl } from '../utils/mail-status'
import type { SendEmailOptions, SendEmailResult } from './send'

/**
 * The mail relay transport — the one that makes this instance's own mail work.
 *
 * zäme sends through Proton, and Proton has no send API: it has Proton Bridge,
 * a local daemon that speaks SMTP and holds the account's keys. A daemon is not
 * something a Nuxt process can contain, so it runs as its own workload on the
 * platform (`kitchen-services`, `services/proton-bridge`) with a small HTTP
 * relay in front of it, and zäme reaches that relay the way it reaches anything
 * else on the platform: by an address the platform handed it,
 * `KITCHEN_SERVICE_MAIL`, never one written down here.
 *
 * The relay is what keeps the bridge's SMTP password OUT of this application.
 * Bridge generates that password itself and it is readable only from inside the
 * bridge's own container; the relay reads it there and speaks SMTP over
 * loopback. What crosses the cluster network is this JSON, authenticated by a
 * shared token that grants exactly one thing — "send this message".
 */
export interface RelaySendBody {
  from: string
  to: string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  attachments?: { filename: string, content: string, contentType?: string }[]
  tag?: string
}

/** `true` when the relay is configured; `sendViaRelay` may then be called. */
export function relayConfigured(): boolean {
  return Boolean(mailRelayUrl() && process.env.MAIL_RELAY_TOKEN)
}

export async function sendViaRelay(opts: SendEmailOptions, from: string): Promise<SendEmailResult> {
  const base = mailRelayUrl()
  const token = process.env.MAIL_RELAY_TOKEN
  if (!base || !token) throw new Error('Mail relay is not configured')

  const body: RelaySendBody = {
    from,
    to: Array.isArray(opts.to) ? opts.to : [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    replyTo: opts.replyTo,
    tag: opts.tag,
    // Base64 on the wire: an .ics attachment is text, but an image is not, and
    // one encoding for both is one fewer thing for either end to get wrong.
    attachments: opts.attachments?.map(a => ({
      filename: a.filename,
      content: typeof a.content === 'string'
        ? Buffer.from(a.content, 'utf8').toString('base64')
        : a.content.toString('base64'),
      contentType: a.contentType
    }))
  }

  const response = await fetch(new URL('/v1/send', base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    // The relay's body says which part of the send failed — the bridge being
    // signed out reads very differently from a rejected recipient — so it is
    // worth carrying up. It never contains the credential.
    const detail = await response.text().catch(() => '')
    throw new Error(`Mail relay refused the message (${response.status}): ${detail.slice(0, 300)}`)
  }

  const result = await response.json().catch(() => ({})) as { id?: string }
  return { sent: true, id: result.id }
}
