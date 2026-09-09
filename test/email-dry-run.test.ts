import { describe, expect, it } from 'vitest'
import { dryRunPayload, linksIn } from '../server/emails/send'

/**
 * The dry-run log is the ONLY way into an instance that has no
 * `RESEND_API_KEY`: the first-run flow mails a magic link, and with no mailer
 * the link exists solely in the log. It used to be `text.slice(0, 200)`, which
 * cut the sign-in URL through the middle of its token — the truncated link
 * failed verification and bounced back to `/setup`, indistinguishable from
 * never having clicked it.
 */

const MAGIC_LINK
  = 'https://zaeme.example.com/api/auth/magic-link/verify'
    + '?token=zWmIKGGwcrPXQ9v3tKq8Lm2ZaR7bY4nF&callbackURL=%2Fhost'

const MAGIC_LINK_TEXT = `zäme

SIGN IN TO ZÄME

Click the button below to securely continue. The link is single-use and
expires shortly.

Sign in to zäme ${MAGIC_LINK}`

describe('the dry-run payload', () => {
  it('carries the sign-in link whole, however long the body is', () => {
    const payload = dryRunPayload({
      to: 'owner@example.com',
      subject: 'Sign in to zäme',
      html: '<p>ignored</p>',
      text: MAGIC_LINK_TEXT
    })
    expect(payload.links).toContain(MAGIC_LINK)
  })

  it('is longer than the preview that used to truncate it', () => {
    // The regression in one line: the body passes 200 characters before the
    // URL ends, so anything sliced to 200 loses the token.
    expect(MAGIC_LINK_TEXT.indexOf(MAGIC_LINK)).toBeGreaterThan(0)
    expect(MAGIC_LINK_TEXT.slice(0, 200)).not.toContain(MAGIC_LINK)
  })

  it('still shows a short preview for orientation', () => {
    const payload = dryRunPayload({
      to: 'owner@example.com', subject: 's', html: '', text: MAGIC_LINK_TEXT
    })
    expect(payload.preview.length).toBeLessThanOrEqual(200)
    expect(payload.preview).toContain('SIGN IN TO ZÄME')
  })
})

describe('linksIn', () => {
  it('keeps the query string intact', () => {
    expect(linksIn(`go to ${MAGIC_LINK} now`)).toEqual([MAGIC_LINK])
  })

  it('trims sentence punctuation rather than swallowing it into the URL', () => {
    expect(linksIn('Visit https://zaeme.example.com/e/party.')).toEqual([
      'https://zaeme.example.com/e/party'
    ])
  })

  it('does not take an href out of markup, where & is escaped', () => {
    // An `&amp;` in an href would produce a URL whose query string is wrong,
    // which is why the payload reads the text part and not the HTML.
    const html = '<a href="https://zaeme.example.com/x?a=1&amp;b=2">go</a>'
    expect(linksIn(html)).toEqual(['https://zaeme.example.com/x?a=1&amp;b=2'])
  })

  it('de-duplicates the same link appearing as button and footer', () => {
    expect(linksIn(`${MAGIC_LINK} ... ${MAGIC_LINK}`)).toHaveLength(1)
  })

  it('answers nothing for a message with no links', () => {
    expect(linksIn('no links here')).toEqual([])
  })
})
