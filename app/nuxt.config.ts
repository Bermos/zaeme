// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  future: {
    compatibilityVersion: 4,
  },

  devtools: { enabled: true },

  modules: ['@nuxt/ui'],

  runtimeConfig: {
    // Private — server-only
    databaseUrl: process.env.DATABASE_URL ?? '',
    betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? '',
    resendApiKey: process.env.RESEND_API_KEY ?? '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    r2AccountId: process.env.R2_ACCOUNT_ID ?? '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    r2BucketName: process.env.R2_BUCKET_NAME ?? '',
    adminEmail: process.env.ADMIN_EMAIL ?? '',
    enableAi: process.env.ENABLE_AI === 'true',
    enableSbb: process.env.ENABLE_SBB !== 'false',
    enableMagicLink: process.env.ENABLE_MAGIC_LINK !== 'false',

    // Public — exposed to client
    public: {
      baseUrl: process.env.BASE_URL ?? 'http://localhost:3000',
      r2PublicUrl: process.env.R2_PUBLIC_URL ?? '',
    },
  },

  // Disable external font providers (network not available in self-hosted environments)
  fonts: {
    providers: {
      google: false,
      googleicons: false,
      bunny: false,
      fontshare: false,
      fontsource: false,
    },
  },

  nitro: {
    experimental: {
      tasks: true,
    },
  },
})
