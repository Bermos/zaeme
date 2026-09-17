import { defineNuxtConfig } from 'nuxt/config'

/**
 * Tailwind `emerald-500` — the fill `public/favicon.svg` already uses, and what
 * `scripts/generate-pwa-icons.mjs` paints the home-screen icons with. It is the
 * one brand colour this app has; everything else is stock Nuxt UI.
 */
const THEME_COLOR = '#10b981'

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
  modules: ['@nuxt/eslint', '@nuxt/ui', '@vite-pwa/nuxt'],

  ssr: true,

  app: {
    head: {
      // The title TEMPLATE is a function, which nuxt.config cannot carry
      // (everything here has to serialise) — it lives in app/app.vue.
      title: 'zäme',
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        // iOS reads THIS and not the web manifest's icons when somebody taps
        // "Add to Home Screen", and it will not take an SVG — without a PNG
        // here Safari screenshots the page and uses that.
        { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon-180.png', sizes: '180x180' }
      ],
      meta: [
        // Matches `theme_color` below; both are the favicon's emerald.
        { name: 'theme-color', content: THEME_COLOR },
        // The standard spelling and the one iOS has always read. Both say the
        // same thing as `display: standalone` in the manifest; Android takes it
        // from the manifest, older iOS from the meta.
        { name: 'mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-capable', content: 'yes' },
        { name: 'apple-mobile-web-app-title', content: 'zäme' }
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
    ],

    /**
     * THE TWO FILES A PHONE FETCHES BEFORE IT TRUSTS ANYTHING (#39).
     *
     * `@vite-pwa/nuxt` will write both of these rules itself when
     * `registerWebManifestInRouteRules` is on, which is why that option is
     * explicitly OFF below: it would give `sw.js` `public, max-age=0,
     * must-revalidate`, and that is one revalidation short of safe here.
     *
     * `no-store` ON THE WORKER, and this is not belt-and-braces. h3 answers a
     * conditional GET **304 when `If-Modified-Since` is satisfied even if the
     * `If-None-Match` it was sent does not match** — RFC 9110 §13.1.3 says a
     * recipient MUST ignore `If-Modified-Since` when `If-None-Match` is present,
     * and this was measured end to end through the production edge, not only
     * against a local build:
     *
     *     wrong etag + far-future If-Modified-Since  ->  304   (RFC says 200)
     *
     * Chrome sends BOTH headers on a worker update check, so a cacheable
     * `sw.js` can be frozen on a phone with no way to reach it. `no-store`
     * removes the whole class rather than the symptom: nothing is stored, so no
     * conditional request is ever made, so the precedence bug is unreachable for
     * the one file where it would hurt. The cost is an unconditional ~18 KB on
     * registration and once an hour, against 1.13 MiB this already precaches.
     *
     * The h3 behaviour itself is NOT fixed here. It is server-wide, it affects
     * every public asset, and it is filed separately. Today its blast radius is
     * small because the worker holds only content-addressed build assets — but
     * #40 and #41 add data caching, and on that day a frozen worker stops being
     * cosmetic. This is the cheapest moment to close it: the PR that introduces
     * `sw.js` at all.
     *
     * `test/pwa-install.test.ts` reads these two rules back out of this object,
     * and `scripts/api-smoke.sh` asserts the header on the wire — a route rule
     * that names a path Nitro never matches is silent, not loud.
     */
    routeRules: {
      '/sw.js': {
        headers: { 'Cache-Control': 'no-store' }
      },
      '/manifest.webmanifest': {
        headers: {
          'Content-Type': 'application/manifest+json',
          // The manifest is precached and re-read on install; revalidating is
          // right for it, and it is not the file the update flow turns on.
          'Cache-Control': 'public, max-age=0, must-revalidate'
        }
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  },

  /**
   * THE HOME-SCREEN APP (#39). A manifest, four icons (three named below, one
   * more in `app.head` for iOS) and a service worker that precaches the build
   * assets — and nothing else, on purpose. Caching any of
   * the DATA is #40/#41, and doing it here by accident is how an invite page
   * starts showing last week's plan.
   *
   * Two things in this block are load-bearing and both look like noise:
   *
   * 1. `navigateFallback: undefined` KEEPS SSR ALIVE, and the key has to be
   *    PRESENT with that value rather than simply left out. `@vite-pwa/nuxt`
   *    tests `if (!('navigateFallback' in options.workbox))` and, finding
   *    nothing, sets it to `/` — which is the right default for a single-page
   *    app and catastrophic here. Workbox would then register a NavigationRoute
   *    that answers EVERY navigation out of the cache, so `/i/<token>` would
   *    stop being server-rendered for anybody who had visited before: no Open
   *    Graph card in the group chat, and a plan rendered from whatever the
   *    client could piece together. Deleting this line does not fail a build.
   *    `test/pwa-install.test.ts` reads the key back out of this object and
   *    `scripts/api-smoke.sh` runs the GENERATED worker against an invite URL,
   *    because a config assertion cannot prove what workbox emitted.
   *
   * 2. `registerType: 'autoUpdate'` IS THE UPDATE FLOW. Merging to `main`
   *    deploys, and a worker that will not update is unreachable once it is on
   *    somebody's home screen — the only remedy left is telling friends to clear
   *    site data. `autoUpdate` (with the client plugin registered, which is the
   *    module's default) turns on `skipWaiting` and `clientsClaim`, so a new
   *    worker activates instead of waiting for every tab to close, and the
   *    client half reloads the page when it sees the new one take control.
   *    `periodicSyncForUpdates` re-checks hourly, which matters for exactly the
   *    case this issue exists for: an installed app that is never fully closed
   *    and so never re-registers. The THIRD half of that flow is a header and
   *    not an option — `sw.js` is served `no-store`, for the reason written out
   *    at `nitro.routeRules` above, and without it the update check Chrome makes
   *    can be answered 304 off a stale copy.
   */
  pwa: {
    registerType: 'autoUpdate',
    // OFF on purpose: the module's own rules would give `sw.js` a revalidating
    // Cache-Control, and it needs `no-store`. Both rules are written by hand in
    // `nitro.routeRules` above, where the reasoning lives.
    registerWebManifestInRouteRules: false,
    manifest: {
      name: 'zäme — plan it with your people',
      short_name: 'zäme',
      description: 'Plan parties, trips and gigs with your friends.',
      // The language of the three strings above, which is what `lang` is for.
      // They are English; the name is Swiss German and is a proper noun.
      lang: 'en',
      display: 'standalone',
      // The app's IDENTITY, pinned rather than inherited. Left out it defaults
      // to `start_url`, so changing where the app opens would look to the phone
      // like a DIFFERENT app: the installed one keeps pointing at the old URL
      // and a second install appears beside it.
      id: '/',
      // Everybody arrives on `/i/<token>`, and nobody wants an installed app
      // that opens on one party forever. It opens on the home page, which is
      // where the rest of their invites are.
      start_url: '/',
      scope: '/',
      theme_color: THEME_COLOR,
      // The stock Nuxt UI light background. It is the splash screen behind the
      // icon on Android, shown before the app has painted anything.
      background_color: '#ffffff',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    },
    workbox: {
      // See (1) above. Present, undefined, and neither half is decorative.
      navigateFallback: undefined,
      // The build assets and the icons, and deliberately nothing else: no
      // runtimeCaching at all, so every document and every `/api/**` call is an
      // ordinary network request the worker does not touch.
      globPatterns: ['**/*.{js,css,svg,png,webmanifest}'],
      // A deploy replaces every hashed asset; the previous release's precache is
      // dead weight and, on a phone, quota.
      cleanupOutdatedCaches: true,
      // One self-contained `sw.js` rather than `sw.js` plus a `workbox-*.js` it
      // pulls in — one request, one cache-busting story, and it is what lets the
      // smoke suite EXECUTE the worker without resolving a second file.
      inlineWorkboxRuntime: true
    },
    client: {
      // Re-check for a new worker every hour, for the installed app that is
      // never closed and so never re-registers on a fresh page load.
      periodicSyncForUpdates: 3600
    },
    // The dev server is not what this feature is about, and a service worker in
    // dev is a debugging trap: an HMR update and a precached asset disagree.
    devOptions: { enabled: false }
  }
})
