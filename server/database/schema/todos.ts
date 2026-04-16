import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'
import { events } from './events'
import { user } from './users'

export const organizerTodos = pgTable('organizer_todos', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  assignedToId: text('assigned_to_id').references(() => user.id, { onDelete: 'set null' }),
  completed: boolean('completed').notNull().default(false),
  dueAt: timestamp('due_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const packListTemplateItems = pgTable('pack_list_template_items', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const attendeePackItems = pgTable('attendee_pack_items', {
  id: text('id').primaryKey(),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  templateItemId: text('template_item_id').references(() => packListTemplateItems.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  checked: boolean('checked').notNull().default(false),
  custom: boolean('custom').notNull().default(false), // true if attendee added it themselves
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
