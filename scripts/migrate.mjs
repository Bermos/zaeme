/**
 * Apply the migration chain, once per deploy.
 *
 * Kitchen runs this as a `task` process (see kitchen.json): it must finish
 * before any of the release takes traffic, and if it fails the deploy stops
 * where it stands with the previous version still serving. That is the whole
 * reason it is not an entrypoint step — an entrypoint migration runs once per
 * replica, simultaneously, on every rollout.
 *
 * Forward-only and idempotent, twice over: drizzle's migrator records what it
 * has applied and skips it, and the SQL itself is written with IF NOT EXISTS.
 * Nothing here has a "down" step — Kitchen never runs one, on a rollback or
 * otherwise, so a rollback rolls back the code and leaves the schema ahead.
 *
 * Plain .mjs on purpose: it runs in the built image with no compile step and
 * leans only on `drizzle-orm` and `pg`, which are runtime dependencies. A
 * drizzle-kit invocation would need the devDependencies a production install
 * prunes away.
 */
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'database',
  'migrations'
)

const url = process.env.DATABASE_URL
if (!url) {
  console.error('[migrate] DATABASE_URL is not set')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url, max: 1 })

try {
  await migrate(drizzle(pool), { migrationsFolder })
  console.log('[migrate] schema is up to date')
} catch (err) {
  console.error('[migrate] failed', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
