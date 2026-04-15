import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { events } from './events.js'
import { attendees } from './attendees.js'

// Organizer to-do list items
export const organizerTodos = pgTable('organizer_todos', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  assigneeId: text('assignee_id'), // user id, nullable
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  dueAt: timestamp('due_at', { withTimezone: true }),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Pack list template items — per event, set by planner
export const packListTemplateItems = pgTable('pack_list_template_items', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Attendee personal pack list items (seeded from template, can be extended)
export const attendeePackItems = pgTable('attendee_pack_items', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: boolean('completed').notNull().default(false),
  isCustom: boolean('is_custom').notNull().default(false),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const organizerTodosRelations = relations(organizerTodos, ({ one }) => ({
  event: one(events, { fields: [organizerTodos.eventId], references: [events.id] }),
}))

export const packListTemplateItemsRelations = relations(packListTemplateItems, ({ one }) => ({
  event: one(events, { fields: [packListTemplateItems.eventId], references: [events.id] }),
}))

export const attendeePackItemsRelations = relations(attendeePackItems, ({ one }) => ({
  attendee: one(attendees, { fields: [attendeePackItems.attendeeId], references: [attendees.id] }),
}))

export type OrganizerTodo = typeof organizerTodos.$inferSelect
export type NewOrganizerTodo = typeof organizerTodos.$inferInsert
export type PackListTemplateItem = typeof packListTemplateItems.$inferSelect
export type AttendeePackItem = typeof attendeePackItems.$inferSelect
