import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { getDb, schema } from '@zaeme/db'

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },

  plugins: process.env.ENABLE_MAGIC_LINK !== 'false'
    ? [
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // Email sending is handled by Resend in Phase 3
          // For now, log the magic link in dev
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[magic-link] ${email}: ${url}`)
          }
          else {
            // TODO: send via Resend in Phase 3
            console.warn('[magic-link] Email sending not yet configured.')
          }
        },
      }),
    ]
    : [],
})
