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
 * It SAYS how many it applied. The migrator is silent about that, so "the task
 * succeeded" and "the task applied your migration" read identically in a deploy
 * log — and the second run of a retried Kitchen task, which must do nothing,
 * could not be told from the first except by its exit code. The `upgrade` job
 * in CI asserts on that line.
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

/**
 * How many migrations the chain has already recorded.
 *
 * drizzle's migrator keeps that in `drizzle.__drizzle_migrations` — its
 * defaults, which is what `migrate()` is called with below, so configuring
 * `migrationsTable` or `migrationsSchema` means moving this query with it.
 * Before the very first run the table does not exist and the answer is nothing
 * yet, which is not the same as zero applied.
 *
 * A count that cannot be read is reported as UNKNOWN rather than as zero. The
 * re-run check downstream asks to see `applied 0`, and it must not be
 * satisfiable by a query that quietly failed.
 */
async function appliedCount() {
  try {
    const { rows } = await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')
    return rows[0]?.n ?? 0
  } catch {
    return null
  }
}

try {
  const before = (await appliedCount()) ?? 0
  await migrate(drizzle(pool), { migrationsFolder })
  const after = await appliedCount()
  if (after === null) {
    console.log('[migrate] applied an unknown number of migrations — drizzle.__drizzle_migrations is unreadable')
  } else {
    console.log(`[migrate] applied ${after - before} migration(s), ${after} in the chain`)
  }
  console.log('[migrate] schema is up to date')
} catch (err) {
  console.error('[migrate] failed', err)
  process.exitCode = 1
} finally {
  await pool.end()
}
