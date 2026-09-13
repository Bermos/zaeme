import { afterEach, describe, expect, it } from 'vitest'
import { emailConfigured, mailRelayUrl, mailTransport } from '../server/utils/mail-status'

/**
 * Which transport an outgoing message takes, and — the reason this file exists
 * — whether the sign-in page is allowed to promise an email at all.
 *
 * The bug being pinned down: an instance with nothing configured accepted an
 * address, said "check your inbox", and wrote the link to stdout. `/login` now
 * asks `emailConfigured()` first, so that answer has to be right.
 */
afterEach(() => {
  delete process.env.MAIL_RELAY_URL
  delete process.env.MAIL_RELAY_TOKEN
  delete process.env.KITCHEN_SERVICE_MAIL
  delete process.env.RESEND_API_KEY
})

describe('the transport is whichever is configured, in order', () => {
  it('is a dry run when nothing is set, and says mail is not configured', () => {
    expect(mailTransport()).toBe('dry-run')
    expect(emailConfigured()).toBe(false)
  })

  it('is Resend when only an API key is set', () => {
    process.env.RESEND_API_KEY = 're_123'
    expect(mailTransport()).toBe('resend')
    expect(emailConfigured()).toBe(true)
  })

  it('takes the platform binding when the relay is bound in', () => {
    process.env.KITCHEN_SERVICE_MAIL = 'http://mail.internal:8080'
    process.env.MAIL_RELAY_TOKEN = 'tok'
    expect(mailRelayUrl()).toBe('http://mail.internal:8080')
    expect(mailTransport()).toBe('relay')
  })

  it('prefers the relay over Resend when both are configured', () => {
    process.env.KITCHEN_SERVICE_MAIL = 'http://mail.internal:8080'
    process.env.MAIL_RELAY_TOKEN = 'tok'
    process.env.RESEND_API_KEY = 're_123'
    expect(mailTransport()).toBe('relay')
  })

  it('lets MAIL_RELAY_URL override the binding, for local development', () => {
    process.env.KITCHEN_SERVICE_MAIL = 'http://mail.internal:8080'
    process.env.MAIL_RELAY_URL = 'http://127.0.0.1:9000'
    expect(mailRelayUrl()).toBe('http://127.0.0.1:9000')
  })

  it('an address with no token is not a usable relay', () => {
    // The relay refuses an unauthenticated send, so falling through to the dry
    // run — and SAYING so — beats a transport that 401s on every message.
    process.env.KITCHEN_SERVICE_MAIL = 'http://mail.internal:8080'
    expect(mailTransport()).toBe('dry-run')
    expect(emailConfigured()).toBe(false)
  })
})
