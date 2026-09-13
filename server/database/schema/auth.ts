import { boolean, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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

/**
 * Registered passkeys — WebAuthn credentials, one row per authenticator.
 *
 * zäme has no passwords, and until this table existed it had exactly one way
 * in: a magic link in an email. That is a single point of failure an instance
 * discovers at the worst possible moment — an instance whose mail transport is
 * not configured, or is broken, cannot be signed in to AT ALL, owner included.
 * A passkey is the second, independent factor of possession: it lives in the
 * owner's authenticator, needs no delivery channel, and cannot be phished.
 *
 * Property keys MUST match the better-auth passkey plugin's field names (the
 * drizzle adapter resolves columns by key); the SQL names stay snake_case like
 * the rest of the file. `credentialID` is the awkward one — it is camelCase
 * with a capital D in the plugin, and renaming it here would silently break
 * lookups at sign-in.
 */
export const guestPasskey = pgTable('zaeme_passkey', {
  id: text('id').primaryKey(),
  name: text('name'),
  publicKey: text('public_key').notNull(),
  userId: text('user_id').notNull().references(() => guestUser.id, { onDelete: 'cascade' }),
  credentialID: text('credential_id').notNull(),
  counter: integer('counter').notNull().default(0),
  deviceType: text('device_type').notNull(),
  backedUp: boolean('backed_up').notNull().default(false),
  transports: text('transports'),
  aaguid: text('aaguid'),
  createdAt: timestamp('created_at').notNull().defaultNow()
}, table => [
  index('zaeme_passkey_user_idx').on(table.userId),
  index('zaeme_passkey_credential_idx').on(table.credentialID)
])

export const guestAuthSchema = {
  user: guestUser,
  session: guestSession,
  account: guestAccount,
  verification: guestVerification,
  passkey: guestPasskey
}
