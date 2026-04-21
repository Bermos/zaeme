import * as React from 'react'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
// import { passkey } from "@better-auth/passkey"
import { db } from './db'
import { sendEmail } from './email'
import { renderEmail } from '../emails/render'
import { MagicLinkEmail } from '../emails/magic-link'
import * as schema from '../database/schema'

/**
 * In-process capture for magic links generated during a request. The
 * `magicLink` plugin only surfaces the target URL through `sendMagicLink`;
 * we stash it here keyed by email so the handler that just triggered
 * `signInMagicLink` can read it back synchronously. Entries are single-use.
 */
export const pendingMagicLinks = new Map<string, { url: string, token: string }>()

export function consumePendingMagicLink(email: string) {
  const entry = pendingMagicLinks.get(email)
  if (entry) pendingMagicLinks.delete(email)
  return entry ?? null
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema
  }),

  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url }) => {
        // Always stash the URL so request handlers can surface it to their
        // caller (used by the guest RSVP flow so the pending-magic-link
        // response works even when email delivery is offline).
        pendingMagicLinks.set(email, { url, token })

        // Determine the surface area. RSVP links round-trip through the
        // invite page, which lets us tune the email copy accordingly.
        const purpose = url.includes('/invite/') ? 'rsvp' : 'sign-in'

        try {
          const { html, text } = await renderEmail(
            React.createElement(MagicLinkEmail, { magicLinkUrl: url, purpose })
          )
          await sendEmail({
            to: email,
            subject: purpose === 'rsvp' ? 'Manage your RSVP' : 'Sign in to zäme',
            html,
            text,
            tag: 'magic-link'
          })
        } catch (err) {
          // Magic-link delivery must never break auth — log and fall through
          // to the pendingMagicLinks fallback surfaced to the caller.
          console.error('[magic-link:send]', err)
        }
      }
    })
    // passkey(),
  ],

  emailAndPassword: {
    enabled: true
  }
})
