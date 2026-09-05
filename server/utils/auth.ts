import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { useDb } from './db'
import { renderMagicLinkEmail, sendEmail } from '../emails/index'
import { getRequestHeaders, type H3Event } from 'h3'
import { guestAuthSchema } from '../database/schema/auth'

/**
 * zäme's better-auth instance — multi-user, magic-link sign-in, over the
 * `zaeme_*` tables.
 *
 * Accounts are optional. First touch is always the invite capability URL; an
 * account adds the cross-event "all my invites" view (`/me`) — the one scope
 * where a durable bearer link would be a real risk, so it is session-gated —
 * and the host surface.
 */

// KITCHEN_URL last: on a preview environment it is the only thing that knows
// the hostname the pull request was published on.
const baseURL = process.env.BETTER_AUTH_URL
  || process.env.BASE_URL
  || process.env.KITCHEN_URL
  || undefined

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
