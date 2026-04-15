import { pgTable, text, timestamp, boolean } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { events } from './events.js'
import { attendees } from './attendees.js'

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),

  // Author — can be a guest attendee
  authorAttendeeId: text('author_attendee_id').references(() => attendees.id, { onDelete: 'set null' }),

  body: text('body').notNull(),
  replyToId: text('reply_to_id'), // self-reference, handled via relation

  // Soft delete
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // Planner-only broadcast
  isAnnouncement: boolean('is_announcement').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const chatMessagesRelations = relations(chatMessages, ({ one, many }) => ({
  event: one(events, { fields: [chatMessages.eventId], references: [events.id] }),
  author: one(attendees, {
    fields: [chatMessages.authorAttendeeId],
    references: [attendees.id],
  }),
  replyTo: one(chatMessages, {
    fields: [chatMessages.replyToId],
    references: [chatMessages.id],
    relationName: 'thread',
  }),
  replies: many(chatMessages, { relationName: 'thread' }),
}))

export type ChatMessage = typeof chatMessages.$inferSelect
export type NewChatMessage = typeof chatMessages.$inferInsert
