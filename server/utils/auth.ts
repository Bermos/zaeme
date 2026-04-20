import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
// import { passkey } from "@better-auth/passkey"
import { db } from './db'
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
      sendMagicLink: async ({ email, token, url, metadata }) => {
        // Email delivery lands in Phase 3. For now we stash the URL so the
        // triggering handler can expose it to the client / logs.
        pendingMagicLinks.set(email, { url, token })
        console.log('[magic-link]', { email, url, metadata })
      }
    })
    // passkey(),
  ],

  emailAndPassword: {
    enabled: true
  }
})
