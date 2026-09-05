import { createAuthClient } from 'better-auth/vue'
import { magicLinkClient } from 'better-auth/client/plugins'

/**
 * The browser-side client for zäme's own better-auth instance (`/api/auth/**`,
 * `zaeme_*` tables). Magic-link is the only sign-in path: an account is never
 * required to RSVP — it just unlocks the cross-event "/me" view (ADR-0019 §3).
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()]
})

export const { useSession, signOut } = authClient
