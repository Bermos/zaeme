import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
// import { passkey } from "@better-auth/passkey"
import { db } from './db'
import * as schema from '../database/schema'

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema
  }),

  plugins: [
    magicLink({
      sendMagicLink: async ({ email, token, url, metadata }, ctx) => {
        console.log({ email, token, url, metadata }, ctx)
      }
    })
    // passkey(),
  ],

  emailAndPassword: {
    enabled: true
  }
})
