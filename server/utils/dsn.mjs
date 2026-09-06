/**
 * Kitchen's postgres binding hands out `?sslmode=require`, and the platform's
 * own comment says what it means by it: encrypt the connection, do NOT verify
 * the certificate — CloudNativePG signs every cluster with a CA it generates
 * itself, and nothing puts that CA in the application's trust store. That is
 * libpq's reading of `require`, and the binding carries no CA to do better.
 *
 * node-postgres does not read it that way today. pg 8.23 treats `require`,
 * `prefer` and `verify-ca` as aliases for `verify-full` — it says so on stderr
 * — so it demands a CA that does not exist and the connection dies with
 * SELF_SIGNED_CERT_IN_CHAIN before the first query. `uselibpqcompat=true` is
 * the flag pg's own warning names for asking for libpq semantics now, and it
 * is what pg 9 will do by default, so this is forward-compatible rather than a
 * pin to today's behaviour.
 *
 * Plain .mjs, and imported rather than duplicated, because BOTH callers need
 * it and one of them is outside the Nitro bundle: `scripts/migrate.mjs` runs
 * as Kitchen's deploy task. The Dockerfile copies this file into the runtime
 * stage for exactly that reason.
 *
 * Tracked upstream as Bermos/Kitchen#443.
 */

/** The sslmode values pg currently over-reads as `verify-full`. */
const OVER_VERIFIED = new Set(['require', 'prefer', 'verify-ca'])

/**
 * Ask for libpq's meaning of `sslmode` where pg would otherwise demand a CA
 * nobody supplied. Anything else — no TLS, an explicit `verify-full` with a
 * real CA, an unparseable string — is handed back untouched, so this can never
 * quietly weaken a connection that was already verifying.
 */
export function libpqCompatDsn(dsn) {
  if (!dsn) return dsn
  let url
  try {
    url = new URL(dsn)
  } catch {
    return dsn
  }
  const sslmode = url.searchParams.get('sslmode')
  if (!sslmode || !OVER_VERIFIED.has(sslmode)) return dsn
  if (url.searchParams.has('uselibpqcompat')) return dsn
  url.searchParams.set('uselibpqcompat', 'true')
  return url.toString()
}
