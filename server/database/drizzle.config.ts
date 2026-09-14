import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit lives with the app again (2026-09): zäme owns its database and
 * therefore its migration chain. `pnpm db:generate` writes a new migration
 * into `server/database/migrations/` from the schema; `pnpm db:migrate`
 * applies the chain. Both go through this config, and both are for LOCAL use
 * only — a dev machine or a scratch database, where `pnpm install` has left
 * drizzle-kit (a devDependency) in place.
 *
 * A deploy runs neither. `kitchen.json` declares a `migrate` task running
 * `node scripts/migrate.mjs`, once per release, before the new version takes
 * any traffic. That script is plain .mjs leaning only on `drizzle-orm` and
 * `pg` because the built image is a production install with devDependencies
 * pruned away, drizzle-kit among them.
 *
 * So when a deploy's `migrate` task fails, `scripts/migrate.mjs` is what to
 * reproduce. `pnpm db:migrate` is a different program under a different
 * dependency set, and may well succeed where the deploy did not.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/database/schema/index.ts',
  out: './server/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!
  }
})
