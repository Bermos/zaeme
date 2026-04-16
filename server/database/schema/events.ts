import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

export const eventTypeEnum = pgEnum('event_type', ['hosted', 'concert', 'series'])
export const eventStatusEnum = pgEnum('event_status', ['draft', 'polling', 'published', 'completed', 'cancelled'])

export const events = pgTable('events', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  type: eventTypeEnum('type').notNull().default('hosted'),
  status: eventStatusEnum('status').notNull().default('draft'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  location: text('location'),
  venueStation: text('venue_station'),    // SBB station name used for travel group clustering
  ticketUrl: text('ticket_url'),          // concert-specific
  performerNote: text('performer_note'),  // concert-specific
  parentId: text('parent_id').references(() => events.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
