import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { magicLink } from 'better-auth/plugins'
import { getDb, schema } from '@zaeme/db'

const config = useRuntimeConfig()

export const auth = betterAuth({
  database: drizzleAdapter(getDb(config.databaseUrl), {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),

  secret: config.betterAuthSecret,
  baseURL: config.public.baseUrl,

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },

  plugins: config.enableMagicLink
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
});
