import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { getDb } from '@zaeme/db/client'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

export default defineNitroPlugin(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.AUTO_MIGRATE === 'true') {
    const runtimeConfig = useRuntimeConfig()
    const db = getDb(runtimeConfig.databaseUrl)

    const migrationsFolder = resolve(
      fileURLToPath(import.meta.url),
      '../../../../packages/db/migrations',
    )

    try {
      console.log('[migrate] Running database migrations...')
      await migrate(db, { migrationsFolder })
      console.log('[migrate] Migrations complete.')
    }
    catch (err) {
      console.error('[migrate] Migration failed:', err)
      throw err
    }
  }
})
