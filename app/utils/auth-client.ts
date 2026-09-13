import { createAuthClient } from 'better-auth/vue'
import { magicLinkClient } from 'better-auth/client/plugins'
import { passkeyClient } from '@better-auth/passkey/client'

/**
 * The browser-side client for zäme's own better-auth instance (`/api/auth/**`,
 * `zaeme_*` tables). Two ways in, and an account is never required to RSVP —
 * signing in just unlocks the cross-event "/me" view (ADR-0019 §3) and hosting:
 *
 *  - `signIn.magicLink` — a guest has an email address and nothing else.
 *  - `signIn.passkey` — the owner's way in, and the only one that keeps working
 *    on an instance that cannot deliver mail. `passkey.addPasskey` registers
 *    one; the server decides who may do that without a session
 *    (`server/utils/passkey-bootstrap.ts`).
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient(), passkeyClient()]
})

export const { useSession, signOut } = authClient

/** Does this browser have WebAuthn at all? SSR says no; the client re-checks. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)
}
