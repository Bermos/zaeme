import { useDb } from '../utils/db'
import * as schema from '../database/schema/events'

/**
 * The events domain reads and writes through the one Drizzle client
 * (`server/utils/db.ts`). `tables` re-exports the namespaced `events_*` tables
 * under their short JS names so the domain logic reads cleanly
 * (`tables.event`, `tables.rsvp`, …).
 */
export { useDb }
export const tables = schema
