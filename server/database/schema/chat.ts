import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'
import { events } from './events'

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => attendees.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  replyToId: text('reply_to_id').references(() => chatMessages.id, { onDelete: 'set null' }),
  announcement: boolean('announcement').notNull().default(false), // planner-only broadcast, no replies
  deletedAt: timestamp('deleted_at', { withTimezone: true }),     // soft delete
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
