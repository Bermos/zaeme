import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema/index.js'

let _client: ReturnType<typeof postgres> | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getDb(databaseUrl?: string) {
  const url = databaseUrl ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }

  if (!_db) {
    _client = postgres(url, { max: 10 })
    _db = drizzle(_client, { schema })
  }

  return _db
}

export type Db = ReturnType<typeof getDb>
export { schema }
