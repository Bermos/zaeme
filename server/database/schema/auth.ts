import { boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * zäme's auth tables — better-auth over magic-link accounts, namespaced
 * `zaeme_*`. The prefix is a leftover from the months these tables shared a
 * database with the Enterprise monorepo's own `user`/`session` tables; it is
 * kept because renaming buys nothing and costs a migration.
 *
 * An account is OPTIONAL. First touch is always an invite capability URL, and
 * a guest is identified by their lowercased email everywhere in the events
 * domain. Signing in adds exactly two things: the cross-event `/me` view, and
 * the ability to host.
 *
 * Property keys MUST match better-auth's field names — the drizzle adapter
 * resolves columns by key, while the SQL names stay snake_case.
 */

export const guestUser = pgTable('zaeme_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const guestSession = pgTable('zaeme_session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => guestUser.id, { onDelete: 'cascade' })
}, table => [
  index('zaeme_session_user_idx').on(table.userId)
])

export const guestAccount = pgTable('zaeme_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => guestUser.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
}, table => [
  index('zaeme_account_user_idx').on(table.userId)
])

export const guestVerification = pgTable('zaeme_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const guestAuthSchema = {
  user: guestUser,
  session: guestSession,
  account: guestAccount,
  verification: guestVerification
}
