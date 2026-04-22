import { createAuthClient } from 'better-auth/vue'
import { magicLinkClient } from 'better-auth/client/plugins'
// import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  plugins: [
    magicLinkClient()
    // passkeyClient()
  ]
})
