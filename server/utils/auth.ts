import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { useDb } from './db'
import { renderMagicLinkEmail, sendEmail } from '../emails/index'
import { getRequestHeaders, type H3Event } from 'h3'
import { guestAuthSchema } from '../database/schema/auth'
import { completeBootstrapRegistration, resolveBootstrapUser } from './passkey-bootstrap'

/**
 * zäme's better-auth instance — multi-user, over the `zaeme_*` tables.
 *
 * Accounts are optional. First touch is always the invite capability URL; an
 * account adds the cross-event "all my invites" view (`/me`) — the one scope
 * where a durable bearer link would be a real risk, so it is session-gated —
 * and the host surface.
 *
 * TWO sign-in methods, and they fail independently, which is the point:
 *
 *  - **magic link**, the one a guest uses, because a guest has an email address
 *    and nothing else;
 *  - **passkey**, the one the owner uses, because the owner needs a way in that
 *    does not depend on this instance being able to deliver mail. An instance
 *    with no mail transport configured can send a magic link precisely nowhere,
 *    and before passkeys that made it unopenable by anybody.
 *
 * They are the same credential class — one better-auth session cookie, one
 * account — so nothing downstream (`requireGuestUser`, `requireOwner`, the
 * audit) has to learn a second shape. The admin surface is still the host
 * session plus `requireOwner`, and there is still no fourth credential.
 */

// KITCHEN_URL last: on a preview environment it is the only thing that knows
// the hostname the pull request was published on.
const baseURL = process.env.BETTER_AUTH_URL
  || process.env.BASE_URL
  || process.env.KITCHEN_URL
  || undefined

/**
 * WebAuthn is bound to an ORIGIN, and a credential registered against the wrong
 * relying-party id is a credential that silently never matches. So both are
 * derived from the one URL this instance already knows it is served at, rather
 * than configured a second time and left to drift.
 *
 * `rpID` is the bare hostname (no scheme, no port — the spec wants a domain),
 * and `origin` is the whole thing. `localhost` is the fallback because that is
 * what `pnpm dev` is, and WebAuthn treats it as a secure context.
 */
const rp = (() => {
  try {
    const url = new URL(baseURL ?? 'http://localhost:3000')
    return { id: url.hostname, origin: url.origin }
  } catch {
    return { id: 'localhost', origin: 'http://localhost:3000' }
  }
})()

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(useDb(), { provider: 'pg', schema: guestAuthSchema }),

  plugins: [
    magicLink({
      // Sign-in link via the shared email seam (the zäme-branded templates).
      sendMagicLink: async ({ email, url }) => {
        const { html, text } = await renderMagicLinkEmail({
          magicLinkUrl: url,
          purpose: 'sign-in'
        })
        await sendEmail({ to: email, subject: 'Sign in to zäme', html, text })
      }
    }),

    /**
     * Passkeys. The default is unchanged for everybody who is already signed
     * in — `addPasskey` needs a session and adds a key to that account.
     *
     * `requireSession: false` is what opens the two circular cases, and it
     * opens NOTHING on its own: with no session the plugin has no user, so it
     * asks `resolveUser`, and that function refuses unless the browser's
     * opaque `context` proves one of exactly two things — this instance has
     * never been claimed, or the caller quoted the operator's break-glass
     * token. `server/utils/passkey-bootstrap.ts` is the whole of that
     * decision, and it is made against the database and the environment, never
     * against anything the browser asserts about itself.
     */
    passkey({
      rpID: rp.id,
      rpName: 'zäme',
      origin: rp.origin,
      registration: {
        requireSession: false,

        // Asked BEFORE the browser touches an authenticator, so it decides and
        // writes nothing.
        resolveUser: async ({ context }) => {
          const user = await resolveBootstrapUser(context)
          if (!user) {
            // The plugin turns a throw into a failed registration. Same message
            // for "no context", "bad token" and "instance already claimed" —
            // there is nothing useful to tell a caller apart from each other.
            throw new Error('Passkey registration needs a session.')
          }
          return user
        },

        // Asked AFTER a key has actually answered, which is where the account
        // gets created and the grant gets recorded. A ceremony somebody starts
        // and then dismisses leaves no trace and no half-claimed instance.
        //
        // It runs for every registration, including an ordinary one by a
        // signed-in account — those carry no bootstrap context, so it parses to
        // nothing and the plugin keeps the user it already had.
        afterVerification: async ({ context, user }) => {
          if (!context) return
          const completed = await completeBootstrapRegistration(context, user)
          if (!completed) {
            throw new Error('Passkey registration could not be completed.')
          }
          return completed
        }
      }
    })
  ]
})

export type GuestSession = Awaited<ReturnType<typeof auth.api.getSession>>

/** Build a web `Headers` from the H3 request (better-auth reads cookies here). */
function requestHeaders(event: H3Event): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(getRequestHeaders(event))) {
    if (typeof value === 'string') {
      headers.set(key, value)
    }
  }
  return headers
}

/** Resolve (and memoise per-request) the zäme session for an H3 event. */
export async function getGuestSession(event: H3Event): Promise<GuestSession> {
  const ctx = event.context as { __zaemeSession?: GuestSession }
  if (ctx.__zaemeSession !== undefined) {
    return ctx.__zaemeSession
  }
  const session = await auth.api
    .getSession({ headers: requestHeaders(event) })
    .catch(() => null)
  ctx.__zaemeSession = session
  return session
}

/** The signed-in zäme user, or a 401. Gates /me and /host APIs. */
export async function requireGuestUser(event: H3Event): Promise<{ id: string, email: string, name: string }> {
  const session = await getGuestSession(event)
  if (!session?.user) {
    throw createError({ statusCode: 401, statusMessage: 'Sign-in required' })
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name }
}
