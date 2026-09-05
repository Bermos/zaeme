import { defineConfig } from 'drizzle-kit'

/**
 * drizzle-kit lives with the app again (2026-09): zäme owns its database and
 * therefore its migration chain. `pnpm db:generate` writes a new migration
 * from the schema; `pnpm db:migrate` applies the chain — and that is what
 * Kitchen runs as the deploy `task`, once per release, before the new version
 * takes any traffic (see kitchen.json).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/database/schema/index.ts',
  out: './server/database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL!
  }
})
