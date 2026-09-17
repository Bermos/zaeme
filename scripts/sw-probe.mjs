#!/usr/bin/env node
/**
 * RUN THE SHIPPED SERVICE WORKER AND ASK IT QUESTIONS.
 *
 * `scripts/api-smoke.sh` is curl and never loads a page, so the one thing it
 * could otherwise say about #39 is that `/sw.js` answers 200 — which is true of
 * a worker that cache-firsts every navigation and silently un-server-renders
 * every invite link for anybody who has visited before. Grepping the worker is
 * no better: it is a minified workbox bundle, `createHandlerBoundToURL` appears
 * in it as a dead class method whether or not a navigation route was ever
 * registered, and an assertion on that string is satisfied by both answers.
 *
 * So this evaluates the real `sw.js` in a `node:vm` with a stub service-worker
 * global, collects the listeners it registers, and then DISPATCHES events at
 * them. What comes back is what the browser would do:
 *
 *   route <path>          `worker` if a route handles a GET for that path,
 *                         `network` if none does — which is the answer every
 *                         document must give, because SSR is what puts the Open
 *                         Graph card in the group chat.
 *   lifecycle             `skipWaiting:<yes|no> clientsClaim:<yes|no>`, the two
 *                         halves of "a deploy reaches an installed phone".
 *   precache-kinds        the sorted first path segment of every precache entry,
 *                         so anything beyond the build assets is visible.
 *
 * The worker source comes in on stdin:
 *
 *   curl -s "$BASE/sw.js" | node scripts/sw-probe.mjs route /i/abc
 *
 * Every failure prints a SENTINEL rather than a plausible answer — `unparseable`
 * for a body that is not a worker at all (a 404 page, an empty response), and
 * `no-fetch-listener` for one that registered none. A helper that answered
 * `network` for those would report a dead server as a clean bill of health.
 */
import vm from 'node:vm'

const ORIGIN = 'https://zaeme.invalid'

function read() {
  return new Promise((resolve) => {
    let s = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', d => s += d).on('end', () => resolve(s))
  })
}

/**
 * Evaluate the worker with just enough of a `ServiceWorkerGlobalScope` for
 * workbox to install its listeners. Nothing here touches the network or a real
 * cache: `caches.open()` hands back an empty one, which is all the routing
 * questions below need.
 */
function evaluate(src) {
  const listeners = {}
  const calls = { skipWaiting: 0, claim: 0 }
  const cache = {
    keys: async () => [],
    match: async () => undefined,
    put: async () => {},
    delete: async () => true,
    addAll: async () => {}
  }
  const self = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
    skipWaiting: () => { calls.skipWaiting++ },
    clients: { claim: async () => { calls.claim++ } },
    registration: { scope: `${ORIGIN}/` },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
    location: new URL(`${ORIGIN}/sw.js`),
    fetch: async () => new Response('')
  }
  self.self = self
  const sandbox = {
    self,
    location: self.location,
    caches: self.caches,
    clients: self.clients,
    registration: self.registration,
    addEventListener: self.addEventListener,
    fetch: self.fetch,
    // Workbox asks `event instanceof FetchEvent` before it treats a handler as
    // belonging to a real fetch. A stub class answers "no", which is the branch
    // that does the plain routing we are asking about.
    FetchEvent: class FetchEvent {},
    Request,
    Response,
    Headers,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Promise
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(src, sandbox, { filename: 'sw.js' })
  return { listeners, calls }
}

const [verb, arg] = process.argv.slice(2)
const src = await read()

let world
try {
  if (!src.trim()) throw new Error('empty')
  world = evaluate(src)
} catch {
  process.stdout.write('unparseable')
  process.exit(0)
}

if (verb === 'route') {
  const fetchListeners = world.listeners.fetch ?? []
  if (!fetchListeners.length) {
    process.stdout.write('no-fetch-listener')
    process.exit(0)
  }
  // A navigation is what a document request looks like to the worker; anything
  // else is asked for as a subresource. Both are GETs and both go through the
  // same router, which is the point — a route that matches `/i/<token>` would
  // match it however it was asked for.
  const navigating = !/\.[a-z0-9]+$/i.test(arg) && !arg.startsWith('/api/')
  const request = {
    url: `${ORIGIN}${arg}`,
    method: 'GET',
    mode: navigating ? 'navigate' : 'cors',
    destination: navigating ? 'document' : 'script',
    headers: new Headers()
  }
  let handled = false
  const event = {
    type: 'fetch',
    request,
    respondWith: () => { handled = true },
    waitUntil: () => {}
  }
  try {
    for (const fn of fetchListeners) fn(event)
  } catch (error) {
    process.stdout.write(`error:${error.message}`)
    process.exit(0)
  }
  process.stdout.write(handled ? 'worker' : 'network')
  process.exit(0)
}

if (verb === 'lifecycle') {
  for (const fn of world.listeners.activate ?? []) {
    // A cache stub is enough for the two calls this verb is about; workbox's
    // own cleanup listener may still stumble over it, and that is not the
    // question being asked.
    try {
      fn({ type: 'activate', waitUntil: () => {} })
    } catch { /* not this verb's business */ }
  }
  // `clients.claim()` is called from an activate listener and resolves on the
  // microtask queue, so give it a turn before reading the counter.
  await new Promise(resolve => setTimeout(resolve, 0))
  const yes = n => (n > 0 ? 'yes' : 'no')
  process.stdout.write(`skipWaiting:${yes(world.calls.skipWaiting)} clientsClaim:${yes(world.calls.claim)}`)
  process.exit(0)
}

if (verb === 'an-asset') {
  // One precached build asset, so a caller can ask `route` about a URL this
  // worker really does own. Hard-coding one is impossible: the names are
  // content hashes and change on every build.
  const asset = src.match(/\{url:"(_nuxt\/[^"]+\.js)"/)
  process.stdout.write(asset ? `/${asset[1]}` : 'no-precached-asset')
  process.exit(0)
}

if (verb === 'precache-kinds') {
  // Read the manifest out of the source rather than out of the running worker:
  // workbox keeps it in a private field whose name the minifier chooses.
  const urls = [...src.matchAll(/\{url:"([^"]+)"/g)].map(m => m[1])
  if (!urls.length) {
    process.stdout.write('no-precache-manifest')
    process.exit(0)
  }
  const kinds = [...new Set(urls.map(u => u.split('/')[0]))].sort()
  process.stdout.write(kinds.join(','))
  process.exit(0)
}

process.stdout.write(`unknown-verb:${verb}`)
