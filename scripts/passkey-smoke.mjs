/**
 * Exercise the PASSKEY paths against a RUNNING zäme with a real database.
 *
 * `pnpm test` proves the gate's decisions in isolation; this proves the whole
 * ceremony — options, a real authenticator's attestation, verification, the
 * session that comes out, and what that session can then reach. It is the
 * second half of the same argument `scripts/api-smoke.sh` makes for `/api/v1`.
 *
 * Three modes, because the three situations are genuinely different and the
 * third is the one an operator most wants to be sure of:
 *
 *   setup        a fresh instance nobody has claimed
 *   recover      a claimed instance whose owner cannot sign in, with
 *                ZAEME_OWNER_BOOTSTRAP_TOKEN installed
 *   no-recovery  the same instance with no token installed — the door is shut
 *
 * Usage:
 *
 *   # a Postgres, migrated, and a built server on :3000
 *   DATABASE_URL=... node scripts/migrate.mjs
 *   pnpm build
 *   DATABASE_URL=... BETTER_AUTH_SECRET=... BASE_URL=http://localhost:3000 \
 *     PORT=3000 node .output/server/index.mjs &
 *
 *   node scripts/passkey-smoke.mjs setup
 *
 *   # then, with the same database and the server restarted carrying a token:
 *   node scripts/passkey-smoke.mjs recover <the-token>
 *   node scripts/passkey-smoke.mjs no-recovery     # server restarted without it
 *
 * BASE_URL overrides the address. The rpId is that URL's hostname, exactly as
 * `server/utils/auth.ts` derives it.
 */
import { newAuthenticator } from './webauthn-authenticator.mjs'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const ORIGIN = BASE
const RPID = new URL(BASE).hostname

let cookies = new Map()
function jar() {
  return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
}
function absorb(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';')
    const i = pair.indexOf('=')
    cookies.set(pair.slice(0, i), pair.slice(i + 1))
  }
}
async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'origin': ORIGIN,
      'cookie': jar(),
      ...(init.headers ?? {})
    }
  })
  absorb(res)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body, location: res.headers.get('location') }
}

function ok(label, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  -> ' + JSON.stringify(extra)}`)
  if (!cond) process.exitCode = 1
}

const b64uJson = obj => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')

const args = process.argv.slice(2)
const mode = args[0]

if (!['setup', 'recover', 'no-recovery'].includes(mode)) {
  console.error('usage: node scripts/passkey-smoke.mjs <setup|recover <token>|no-recovery>')
  process.exit(2)
}

if (mode === 'setup') {
  const context = 'setup:' + b64uJson({ name: 'Ada Lovelace', email: 'ada@example.com' })

  // 1. A ceremony that is proposed and then abandoned must claim nothing.
  const proposed = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`)
  ok('options are issued for an unclaimed instance', proposed.status === 200, proposed)
  const stillUnclaimed = await call('/api/setup/status')
  ok('abandoning the prompt leaves the instance unclaimed', stillUnclaimed.body.setupRequired === true, stillUnclaimed.body)

  // 2. A context with no proof at all is refused.
  const bare = await call('/api/auth/passkey/generate-register-options')
  ok('no context is refused, as a 401', bare.status === 401, bare)

  // 3. The real thing.
  cookies = new Map()
  const opts = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`)
  ok('register options issued', opts.status === 200 && opts.body.challenge, opts)
  const auth = newAuthenticator({ origin: ORIGIN, rpId: RPID })
  const verified = await call('/api/auth/passkey/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ response: auth.register(opts.body.challenge), name: 'Owner passkey', context, createSession: true })
  })
  ok('registration verified', verified.status === 200, verified)

  const claimed = await call('/api/setup/status')
  ok('the instance is now claimed', claimed.body.setupRequired === false, claimed.body)

  const session = await call('/api/auth/get-session')
  ok('the ceremony signed the owner in', session.body?.user?.email === 'ada@example.com', session.body)

  const adminMe = await call('/api/admin/me')
  ok('the new account is the instance owner', adminMe.status === 200, adminMe)

  const securityPage = await call('/admin/security', { redirect: 'manual' })
  ok('the security page renders', securityPage.status === 200, {
    status: securityPage.status,
    location: securityPage.location
  })

  const security = await call('/api/admin/security')
  ok('the passkey is listed on the security page', security.body?.passkeys?.length === 1, security.body)
  ok('the listing carries no public key or credential id', !JSON.stringify(security.body).includes('publicKey'), security.body)

  // 4. Setup is a one-shot: a FRESH visitor must not be able to claim it again.
  //    (With the owner's own cookie the plugin adds a key to the signed-in
  //    account and ignores the context, which is the ordinary path.)
  const ownerJar = new Map(cookies)
  cookies = new Map()
  const again = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`)
  ok('a second claim from a signed-out visitor is refused, as a 401', again.status === 401, again)
  cookies = ownerJar

  // 5. Sign out, then sign back in with the passkey alone.
  await call('/api/auth/sign-out', { method: 'POST', body: '{}' })
  const signedOut = await call('/api/auth/get-session')
  ok('signed out', !signedOut.body?.user, signedOut.body)

  const authOpts = await call('/api/auth/passkey/generate-authenticate-options')
  ok('authentication options issued', authOpts.status === 200 && authOpts.body.challenge, authOpts)
  const signedIn = await call('/api/auth/passkey/verify-authentication', {
    method: 'POST',
    body: JSON.stringify({ response: auth.authenticate(authOpts.body.challenge) })
  })
  ok('signed in with the passkey', signedIn.status === 200 && signedIn.body?.user?.email === 'ada@example.com', signedIn)

  const ownerAgain = await call('/api/admin/me')
  ok('the passkey session reaches the admin surface', ownerAgain.status === 200, ownerAgain)
}

if (mode === 'recover') {
  const token = args[1]
  const status = await call('/api/setup/status')
  ok('the instance advertises that recovery is available', status.body.recoveryAvailable === true, status.body)

  // The API answering is not the same as the owner being able to REACH it.
  // `/setup/recover` was a 302 to `/` in production while every API check here
  // passed: Nuxt reads a `setup.vue` beside a `setup/` directory as the parent
  // route of everything in it, so the recovery page never rendered and the
  // parent's own redirect ran instead.
  // `redirect: 'manual'` is the whole point: fetch follows a 302 by default,
  // so the broken version — /setup/recover bouncing to / — would have answered
  // 200 here and this check would have passed while the owner was locked out.
  const page = await call('/setup/recover', { redirect: 'manual' })
  ok('the recovery page renders instead of redirecting', page.status === 200, {
    status: page.status,
    location: page.location
  })

  const wrong = 'owner-bootstrap:not-the-token'
  const refused = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(wrong)}`)
  ok('a wrong token is refused, as a 401', refused.status === 401, refused)

  cookies = new Map()
  const context = 'owner-bootstrap:' + token
  const opts = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`)
  ok('the right token gets options', opts.status === 200, opts)

  const auth = newAuthenticator({ origin: ORIGIN, rpId: RPID })
  const verified = await call('/api/auth/passkey/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ response: auth.register(opts.body.challenge), context, createSession: true })
  })
  ok('recovery registration verified', verified.status === 200, verified)

  const session = await call('/api/auth/get-session')
  ok('recovery signed the OWNER in', session.body?.user?.email === 'ada@example.com', session.body)

  const security = await call('/api/admin/security')
  ok('the owner now has two passkeys', security.body?.passkeys?.length === 2, security.body)
  ok('the page warns the token is still installed', security.body?.bootstrapInstalled === true, security.body)
}

if (mode === 'no-recovery') {
  const status = await call('/api/setup/status')
  ok('recovery is not advertised when no token is installed', status.body.recoveryAvailable === false, status.body)
  const context = 'owner-bootstrap:anything'
  const refused = await call(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(context)}`)
  ok('and every token is refused, as a 401', refused.status === 401, refused)
}

console.log(process.exitCode ? '\nsome checks failed' : '\nall checks passed')
