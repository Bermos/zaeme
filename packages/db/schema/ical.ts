import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { attendees } from './attendees.js'

export const icalTokens = pgTable('ical_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  attendeeId: text('attendee_id').notNull().unique().references(() => attendees.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique().$defaultFn(() => createId()),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const icalTokensRelations = relations(icalTokens, ({ one }) => ({
  attendee: one(attendees, { fields: [icalTokens.attendeeId], references: [attendees.id] }),
}))

export type IcalToken = typeof icalTokens.$inferSelect
export type NewIcalToken = typeof icalTokens.$inferInsert
