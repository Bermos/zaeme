import { createAuthClient } from 'better-auth/vue'
import { magicLinkClient } from 'better-auth/client/plugins'
// import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  /** The base URL of the server (optional if you're using the same domain) */
  baseURL: 'http://localhost:3000',

  plugins: [
    magicLinkClient()
    // passkeyClient()
  ]
})
