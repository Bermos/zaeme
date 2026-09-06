import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from '../database/schema'
import { libpqCompatDsn } from './dsn.mjs'

/**
 * zäme's Postgres connection — its OWN database, not a schema inside somebody
 * else's (the 2026-09 separation from the Enterprise monorepo). Kitchen
 * provisions it and binds `DATABASE_URL`; nothing else configures this.
 *
 * node-postgres (the plain wire protocol) on purpose: the Kitchen postgres
 * claim is an ordinary Postgres on :5432, so the Neon serverless HTTP driver
 * this repo once used cannot reach it at all.
 */
let _pool: pg.Pool | undefined

export function getPool(): pg.Pool {
  if (!_pool) {
    const url = process.env.DATABASE_URL
    if (!url) {
      throw new Error('DATABASE_URL environment variable is not set')
    }
    _pool = new pg.Pool({ connectionString: libpqCompatDsn(url) })
  }
  return _pool
}

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined

/**
 * The one memoised Drizzle client, bound to the whole schema (`events_*` +
 * the `zaeme_*` auth tables) so better-auth's relational adapter and the
 * domain's query builder share a single pool.
 */
export function useDb() {
  _db ??= drizzle(getPool(), { schema })
  return _db
}

export type Db = ReturnType<typeof useDb>
