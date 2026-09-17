import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../nuxt.config'

/**
 * WHAT MAKES ZÄME INSTALLABLE, AND WHAT KEEPS IT SERVER-RENDERED (#39).
 *
 * This file reads the REAL `nuxt.config.ts` object — the one the build reads —
 * rather than the source text of it. That distinction is the whole reason the
 * file exists: `grep navigateFallback nuxt.config.ts` is satisfied by a line
 * inside a comment, by a key spelled `navigationFallback`, and by an object
 * that is never reached. Importing the config executes it.
 *
 * WHAT THIS FILE CANNOT SEE is the generated service worker, which is the thing
 * that actually ships: there is no build here, and workbox's output is a
 * minified bundle where the presence of a string proves nothing. That half is
 * `scripts/sw-probe.mjs`, which `scripts/api-smoke.sh` drives against the built
 * server — it evaluates `sw.js` and dispatches a fetch event at it, so "an
 * invite navigation goes to the network" is executed rather than asserted.
 * Neither half is sufficient: this one catches a config edit that would never
 * reach a build, that one catches a module upgrade that changes what the same
 * config produces.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const pwa = config.pwa as {
  registerType?: string
  registerWebManifestInRouteRules?: boolean
  manifest?: {
    name?: string
    short_name?: string
    display?: string
    start_url?: string
    scope?: string
    theme_color?: string
    background_color?: string
    icons?: { src: string, sizes: string, type: string, purpose: string }[]
  }
  workbox?: Record<string, unknown>
  client?: { periodicSyncForUpdates?: number }
}

const head = config.app?.head as {
  link?: { rel?: string, href?: string, sizes?: string }[]
  meta?: { name?: string, content?: string }[]
}

const routeRules = config.nitro?.routeRules as
  Record<string, { headers?: Record<string, string> }> | undefined

/** The width and height a PNG declares in its IHDR, or `null` if it is not one. */
function pngSize(file: string): { width: number, height: number } | null {
  const bytes = readFileSync(file)
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the service worker leaves the server rendering', () => {
  it('keeps SSR on, which is what the rest of this file protects', () => {
    // An invite link has to answer with real HTML and an Open Graph card. If
    // this ever went false the worker questions below would be moot — and the
    // answer to them would silently stop mattering, which is the failure mode
    // worth pinning here rather than in a comment.
    expect(config.ssr).toBe(true)
  })

  it('declares navigateFallback PRESENT and undefined, both halves on purpose', () => {
    const workbox = pwa.workbox!
    // PRESENT: `@vite-pwa/nuxt` fills this in with `/` when the key is missing
    // (`if (!('navigateFallback' in options.workbox))`), which would register a
    // NavigationRoute answering every document out of the cache. Deleting the
    // line is a one-character change with no build error and no failing type,
    // and it would un-server-render every invite link for every repeat visitor.
    expect(Object.keys(workbox)).toContain('navigateFallback')
    // UNDEFINED: any value at all is a navigation route.
    expect(workbox.navigateFallback).toBeUndefined()
  })

  it('caches build assets and nothing else — the data caching is #40/#41', () => {
    const workbox = pwa.workbox!
    // No runtime caching whatsoever. #40 and #41 are where a considered answer
    // to "what may be served stale" goes; arriving at one by accident here is
    // how an invite page starts showing last week's plan. A deliberate change
    // has to come past this line.
    expect(workbox.runtimeCaching).toBeUndefined()
    // The glob names file KINDS, so nothing that is not a build artefact can be
    // swept in by it.
    expect(workbox.globPatterns).toEqual(['**/*.{js,css,svg,png,webmanifest}'])
  })
})

describe('a deploy reaches a phone that has zäme on its home screen', () => {
  it('registers the worker in autoUpdate mode', () => {
    // This is what turns on `skipWaiting` and `clientsClaim` in the generated
    // worker AND the client half that reloads the page once the new worker takes
    // control. `prompt` would leave a friend looking at a stale app with no idea
    // that a service worker is a thing they are supposed to dismiss a banner
    // about. That the generated worker really carries both is asserted by
    // `sw-probe.mjs lifecycle` in the smoke suite.
    expect(pwa.registerType).toBe('autoUpdate')
  })

  it('re-checks for a new worker on a timer, for the app that is never closed', () => {
    // An installed app can sit open for days without ever re-registering, which
    // is exactly the case this issue exists for.
    expect(pwa.client?.periodicSyncForUpdates).toBeGreaterThan(0)
  })

  it('serves sw.js no-store, so no conditional request is ever made for it', () => {
    // NOT BELT-AND-BRACES. h3 answers a conditional GET 304 when
    // `If-Modified-Since` is satisfied even though the `If-None-Match` it was
    // sent does not match (RFC 9110 §13.1.3 says the recipient MUST ignore the
    // date when an etag is present), measured through the production edge as
    // well as locally. Chrome sends both on a worker update check, so a
    // CACHEABLE sw.js can be frozen on a phone that cannot be reached. With
    // `no-store` nothing is stored, so no conditional request is made, so the
    // precedence bug is unreachable for the one file where it would hurt.
    //
    // A revalidating value here is NOT good enough and that is the whole point:
    // `must-revalidate` is what sends the conditional request in the first
    // place. Asserted as an exact string for that reason.
    expect(routeRules?.['/sw.js']?.headers?.['Cache-Control']).toBe('no-store')
  })

  it('writes both route rules by hand rather than letting the module do it', () => {
    // The module's own rules (`registerWebManifestInRouteRules`) would give
    // sw.js `public, max-age=0, must-revalidate`. Turning that option back on
    // without removing the rules above is the edit this pins: the module
    // assigns over the whole entry, so the hand-written `no-store` would be
    // replaced and nothing else here would notice.
    expect(pwa.registerWebManifestInRouteRules).toBe(false)
    // The manifest keeps its own type; it is served by the same two rules, and
    // losing this makes the app silently uninstallable on Android.
    expect(routeRules?.['/manifest.webmanifest']?.headers?.['Content-Type'])
      .toBe('application/manifest+json')
  })
})

describe('the manifest describes an app a phone will install', () => {
  const manifest = pwa.manifest!

  it('is standalone, in scope, and starts on the home page', () => {
    expect(manifest.display).toBe('standalone')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
  })

  it('offers 192, 512 and a maskable 512', () => {
    const icons = manifest.icons ?? []
    const shape = icons.map(i => `${i.purpose} ${i.sizes}`).sort()
    // Android wants a 192 to install and a 512 for the splash screen; the
    // maskable one is a SEPARATE drawing (full bleed, smaller glyph) and not
    // the same file listed twice, because a launcher crops it to its own shape.
    expect(shape).toEqual(['any 192x192', 'any 512x512', 'maskable 512x512'])
    expect(new Set(icons.map(i => i.src)).size).toBe(icons.length)
  })

  it('names icons that exist and really are the size they claim', () => {
    // A manifest citing a missing or mis-sized icon is silently uninstallable:
    // Chrome declines the install prompt and says so in a devtools panel nobody
    // has open. The files are generated by `scripts/generate-pwa-icons.mjs` and
    // committed, so nothing at build time would notice either.
    for (const icon of manifest.icons ?? []) {
      const file = join(ROOT, 'public', icon.src.replace(/^\//, ''))
      expect(existsSync(file), `${icon.src} is missing from public/`).toBe(true)
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(file), `${icon.src} is not a PNG`).toEqual({ width, height })
      expect(icon.type).toBe('image/png')
    }
  })
})

describe('the head iOS reads', () => {
  it('carries an apple-touch-icon PNG that exists at 180', () => {
    // iOS does NOT read the web manifest's icons for "Add to Home Screen" and
    // will not take an SVG. With no PNG here Safari uses a screenshot of the
    // page, which is how a home-screen icon ends up being a blurry picture of a
    // login form.
    const link = head.link?.find(l => l.rel === 'apple-touch-icon')
    expect(link, 'no apple-touch-icon link').toBeTruthy()
    expect(link!.href!.endsWith('.png')).toBe(true)
    const file = join(ROOT, 'public', link!.href!.replace(/^\//, ''))
    expect(existsSync(file), `${link!.href} is missing from public/`).toBe(true)
    expect(pngSize(file)).toEqual({ width: 180, height: 180 })
    expect(link!.sizes).toBe('180x180')
  })

  it('says the same theme colour as the manifest', () => {
    // Two places state this and a phone reads both — the meta colours the
    // browser chrome on a tab, the manifest the title bar of the installed app.
    // They drift the moment somebody edits one.
    const meta = head.meta?.find(m => m.name === 'theme-color')
    expect(meta?.content).toBe(pwa.manifest!.theme_color)
  })

  it('still serves the SVG favicon to desktop browsers', () => {
    // The PWA icons are additions, not a replacement: nothing above should have
    // taken the crisp vector away from the browser tab.
    expect(head.link?.some(l => l.rel === 'icon' && l.href === '/favicon.svg')).toBe(true)
  })
})
