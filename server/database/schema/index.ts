/**
 * zäme's complete database schema — the events domain (`events_*`) and the
 * better-auth tables backing optional guest accounts (`zaeme_*`). One file for
 * drizzle-kit to point at, and the schema `server/utils/db.ts` binds.
 */
export * from './events'
export * from './auth'
