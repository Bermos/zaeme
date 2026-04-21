import { relations } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth'

/**
 * Per-attendee iCal feed token. Serves the unauthenticated
 * `GET /calendar/[token].ics` feed — the token scope is "all events the
 * bearer has RSVP'd yes/maybe to", identified by either a registered
 * `userId` or a guest `email`.
 *
 * Treat the token as a credential (unguessable cuid2).
 */
export const icalToken = pgTable(
  'ical_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'cascade' }),
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('ical_token_userId_idx').on(table.userId),
    index('ical_token_email_idx').on(table.email),
    uniqueIndex('ical_token_user_unique').on(table.userId),
    uniqueIndex('ical_token_email_unique').on(table.email)
  ]
)

export const icalTokenRelations = relations(icalToken, ({ one }) => ({
  user: one(user, {
    fields: [icalToken.userId],
    references: [user.id]
  })
}))
