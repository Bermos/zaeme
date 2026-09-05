import { defineNuxtConfig } from 'nuxt/config'

/**
 * zäme — the collaborative event planner for friends.
 *
 * A single Nuxt package, deliberately: no pnpm workspace, no `packages/*`, no
 * layers. Kitchen builds this repo with buildpacks (framework `nuxt`), and a
 * flat package is what makes that boring — there is no workspace member for
 * Nitro to emit as an external import and then fail to find at boot.
 *
 *  - **SSR on** — invite links must render real HTML with Open Graph cards.
 *  - **Stock Nuxt UI** — default theme, light/dark by system preference.
 *  - **No global auth guard** — a guest's invite link IS their access; the
 *    magic-link account gates only /me and /host.
 *
 * The port comes from `$PORT` (Nitro's node server reads it directly, ahead of
 * its own default) — the platform sets it and a buildpacks image has no other
 * way to be told. Nothing here hard-codes 3000.
 */
export default defineNuxtConfig({
  modules: ['@nuxt/eslint', '@nuxt/ui'],

  ssr: true,

  app: {
    head: {
      // The title TEMPLATE is a function, which nuxt.config cannot carry
      // (everything here has to serialise) — it lives in app/app.vue.
      title: 'zäme',
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }
      ]
    }
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: {}
  },

  compatibilityDate: '2025-01-15',

  nitro: {
    /**
     * The OpenAPI contract travels with the build. `server/api/openapi.yaml.get.ts`
     * reads it through `useStorage('assets:contract')`, which is what puts the
     * file inside `.output` — a plain `readFile` would work in dev and 404 in the
     * built image, where `docs/` does not exist. `dir` is relative to the Nitro
     * source root (`server/`).
     */
    serverAssets: [
      { baseName: 'contract', dir: '../docs' }
    ]
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
