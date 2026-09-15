/**
 * zäme's complete database schema — the events domain (`events_*`), the
 * better-auth tables backing optional guest accounts (`zaeme_*`), and the
 * instance audit log and the geocoder cache (#32). One file for drizzle-kit to
 * point at, and the schema `server/utils/db.ts` binds.
 */
export * from './events'
export * from './auth'
export * from './audit'
export * from './geocode'
