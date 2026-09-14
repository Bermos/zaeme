/**
 * Stand up the two things `scripts/api-smoke.sh` needs that a fresh database
 * does not have, so that CI can run it unattended.
 *
 * It exists because the smoke script's own header documents this dance for a
 * human at a terminal — `psql`, a cookie jar, `awk` over Netscape cookie
 * format — and a workflow file is the wrong place to keep twenty lines of that.
 * Nothing here is app code: it only writes rows and drives the public
 * sign-in endpoints the same way a browser would.
 *
 * Two subcommands, because they happen either side of the server boot:
 *
 *   seed     before the server starts. Two `zaeme_user` rows, in a DEFINITE
 *            created_at order: the instance owner is the FIRST account
 *            registered (`server/utils/instance.ts`), which is what the
 *            machine API acts as and what `requireOwner` lets into /api/admin.
 *            The second row is what makes the 403 half of the admin boundary
 *            possible at all — with one account every session is the owner's.
 *
 *   sign-in  after the server answers /healthz. Runs the real magic-link
 *            ceremony for both accounts, appends the two session cookies to
 *            `$GITHUB_ENV` itself and masks them on stdout, so neither reaches
 *            the build log. The verification token is read from
 *            `zaeme_verification` rather than from the dry-run log: the log
 *            holds it (in `links`, untruncated), but matching the row by email
 *            is the only way two sign-ins cannot be confused for each other.
 *            Off a runner it falls back to printing `NAME=value`.
 *
 * Plain .mjs, like `scripts/migrate.mjs`, and for the same reason: it leans
 * only on `pg`, a runtime dependency, and needs no compile step.
 */
import { appendFileSync } from 'node:fs'
import pg from 'pg'

/** The two accounts. The owner is seeded first and stays first. */
export const OWNER = { id: 'ci_owner', name: 'CI Owner', email: 'owner@example.com' }
export const GUEST = { id: 'ci_guest', name: 'CI Guest', email: 'planner@example.com' }

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[ci-smoke-setup] DATABASE_URL is not set')
  process.exit(1)
}

const base = (process.env.BASE_URL || 'http://127.0.0.1:3111').replace(/\/$/, '')
const pool = new pg.Pool({ connectionString: url, max: 1 })

/**
 * Seed the two accounts.
 *
 * `created_at` is set explicitly and a second apart rather than left to
 * `defaultNow()`: the owner is resolved by `order by created_at asc limit 1`,
 * and two rows inserted in the same statement can share a timestamp to the
 * microsecond, which would make the owner whichever one the planner felt like
 * returning that day. A flaky owner is a flaky 403.
 */
async function seed() {
  await pool.query(
    `insert into zaeme_user (id, name, email, email_verified, created_at, updated_at)
     values ($1, $2, $3, true, now() - interval '2 seconds', now()),
            ($4, $5, $6, true, now() - interval '1 second', now())
     on conflict (id) do nothing`,
    [OWNER.id, OWNER.name, OWNER.email, GUEST.id, GUEST.name, GUEST.email]
  )
  const { rows } = await pool.query(
    'select id, email from zaeme_user order by created_at asc limit 1'
  )
  if (rows[0]?.id !== OWNER.id) {
    throw new Error(`[ci-smoke-setup] the instance owner resolved to ${rows[0]?.id ?? 'nobody'}, not ${OWNER.id}`)
  }
  console.log(`[ci-smoke-setup] owner=${OWNER.email} (${OWNER.id}), second account=${GUEST.email} (${GUEST.id})`)
}

/**
 * The magic-link sign-in, end to end, for one account.
 *
 * POST the address, read the token better-auth just wrote to
 * `zaeme_verification` (its `value` carries the email, so two concurrent
 * sign-ins cannot be confused for each other), then follow the verify URL
 * WITHOUT redirects and take the cookie off the 302.
 */
async function signIn({ email, name }) {
  const posted = await fetch(`${base}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    // better-auth's CSRF middleware rejects a POST with no Origin outright
    // (`MISSING_OR_NULL_ORIGIN`), which a browser would always send and fetch
    // does not. Same-origin, so it is the trusted one.
    headers: { 'content-type': 'application/json', 'origin': base },
    body: JSON.stringify({ email, name, callbackURL: '/host' })
  })
  if (!posted.ok) {
    throw new Error(`[ci-smoke-setup] sign-in/magic-link for ${email} answered ${posted.status}: ${await posted.text()}`)
  }

  const { rows } = await pool.query(
    `select identifier from zaeme_verification
      where value like $1 and expires_at > now()
      order by created_at desc limit 1`,
    [`%"email":"${email}"%`]
  )
  const token = rows[0]?.identifier
  if (!token) {
    throw new Error(`[ci-smoke-setup] no unconsumed magic-link token in zaeme_verification for ${email}`)
  }

  const verified = await fetch(
    `${base}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent('/host')}`,
    { redirect: 'manual' }
  )
  const setCookie = verified.headers.getSetCookie?.() ?? []
  const session = setCookie
    .map(c => c.split(';')[0].trim())
    .find(c => /session_token=/.test(c) && !/session_token=($|;)/.test(c))
  if (!session) {
    throw new Error(`[ci-smoke-setup] magic-link/verify for ${email} set no session cookie (status ${verified.status})`)
  }
  return session
}

/**
 * Escaping for a `::workflow command::` payload. `%` MUST go first and it is
 * not pedantry: a better-auth cookie is percent-encoded, so an unescaped
 * `%2B` would reach the runner as a literal `+` and it would then mask a
 * string that never appears — the mask would look armed and hide nothing.
 */
function escapeCommandData(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

/**
 * Hand one cookie to the job without putting it in the log.
 *
 * The mask has to be registered BEFORE the value is first printed, and the
 * runner reprints a step's whole `env` block in the next step's group header —
 * so simply writing to `$GITHUB_ENV` and saying nothing publishes it there.
 * Hence the ordering here: `::add-mask::` on stdout first, the assignment
 * appended to the `$GITHUB_ENV` FILE second.
 *
 * Appending to that file ourselves, rather than letting the workflow redirect
 * our stdout into it, is the whole trick — stdout is where the workflow
 * command has to go, and it cannot be both.
 *
 * Both the bare token and the whole `name=value` are masked: the value is what
 * the env block prints, the token is what would leak from anything that
 * re-spells the cookie.
 */
function exportCookie(name, cookie) {
  const envFile = process.env.GITHUB_ENV
  if (!envFile) {
    // Not on a runner: behave as before so `eval "$(… sign-in)"` still works.
    console.log(`${name}=${cookie}`)
    return
  }
  const token = cookie.slice(cookie.indexOf('=') + 1)
  console.log(`::add-mask::${escapeCommandData(token)}`)
  console.log(`::add-mask::${escapeCommandData(cookie)}`)
  appendFileSync(envFile, `${name}=${cookie}\n`)
  console.log(`[ci-smoke-setup] ${name} exported and masked`)
}

const [command] = process.argv.slice(2)

try {
  if (command === 'seed') {
    await seed()
  } else if (command === 'sign-in') {
    // The smoke script reads both as whole `Cookie:` header values.
    exportCookie('ZAEME_TEST_SESSION_COOKIE', await signIn(OWNER))
    exportCookie('ZAEME_TEST_GUEST_COOKIE', await signIn(GUEST))
  } else {
    console.error('[ci-smoke-setup] usage: node scripts/ci-smoke-setup.mjs <seed|sign-in>')
    process.exitCode = 1
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
} finally {
  await pool.end()
}
