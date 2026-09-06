import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain .mjs, shared with scripts/migrate.mjs which runs outside the bundle
import { libpqCompatDsn } from '../server/utils/dsn.mjs'

/**
 * Kitchen's postgres binding is `?sslmode=require` and means libpq's `require`
 * — encrypt, do not verify — but pg 8.x reads it as `verify-full` and dies on
 * CloudNativePG's self-signed CA. Reproduced against a real TLS Postgres:
 * the DSN as Kitchen gives it fails DEPTH_ZERO_SELF_SIGNED_CERT; normalised it
 * connects. These pin the narrowness of that rewrite.
 */
describe('libpqCompatDsn', () => {
  it('asks for libpq semantics where pg would over-verify', () => {
    for (const mode of ['require', 'prefer', 'verify-ca']) {
      const out = libpqCompatDsn(`postgresql://u:p@h:5432/d?sslmode=${mode}`)
      expect(out).toContain('uselibpqcompat=true')
      expect(out).toContain(`sslmode=${mode}`)
    }
  })

  it('leaves verify-full alone — that one means what it says', () => {
    const dsn = 'postgresql://u:p@h:5432/d?sslmode=verify-full'
    expect(libpqCompatDsn(dsn)).toBe(dsn)
  })

  it('leaves a plaintext DSN alone rather than inventing TLS', () => {
    const dsn = 'postgresql://u:p@h:5432/d'
    expect(libpqCompatDsn(dsn)).toBe(dsn)
  })

  it('never overrides an explicit uselibpqcompat', () => {
    const dsn = 'postgresql://u:p@h:5432/d?sslmode=require&uselibpqcompat=false'
    expect(libpqCompatDsn(dsn)).toBe(dsn)
  })

  it('hands back anything it cannot parse, rather than throwing', () => {
    expect(libpqCompatDsn('not a url')).toBe('not a url')
    expect(libpqCompatDsn('')).toBe('')
    expect(libpqCompatDsn(undefined)).toBe(undefined)
  })

  it('preserves the rest of the query string', () => {
    const out = libpqCompatDsn('postgresql://u:p@h:5432/d?sslmode=require&application_name=zaeme')
    expect(out).toContain('application_name=zaeme')
    expect(out).toContain('uselibpqcompat=true')
  })
})
