import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'

export const icalTokens = pgTable('ical_tokens', {
  id: text('id').primaryKey(),
  attendeeId: text('attendee_id').notNull().unique().references(() => attendees.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
