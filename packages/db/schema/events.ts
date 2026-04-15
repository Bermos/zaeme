import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  boolean,
  integer,
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { eventPlanners } from './planners.js'
import { attendees } from './attendees.js'
import { travelGroups } from './travel.js'
import { organizerTodos } from './todos.js'
import { packListTemplateItems } from './todos.js'
import { media } from './media.js'
import { chatMessages } from './chat.js'
import { datePolls } from './datepoll.js'

export const eventStatusEnum = pgEnum('event_status', [
  'draft',
  'polling',
  'published',
  'completed',
  'cancelled',
])

export const eventTypeEnum = pgEnum('event_type', [
  'hosted',
  'concert',
  'series',
])

export const events = pgTable('events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  type: eventTypeEnum('type').notNull().default('hosted'),
  status: eventStatusEnum('status').notNull().default('draft'),

  // Dates
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),

  // Location
  venue: text('venue'),
  venueAddress: text('venue_address'),
  venueStation: text('venue_station'),
  venueLatitude: text('venue_latitude'),
  venueLongitude: text('venue_longitude'),

  // Concert-specific
  ticketUrl: text('ticket_url'),
  performerNote: text('performer_note'),

  // Series support
  parentId: text('parent_id'), // self-reference added via relations

  // Visibility
  isPublic: boolean('is_public').notNull().default(false),

  // RSVP limit (null = unlimited)
  maxAttendees: integer('max_attendees'),

  // Invite token for sharing
  inviteToken: text('invite_token').notNull().$defaultFn(() => createId()),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const eventsRelations = relations(events, ({ many, one }) => ({
  planners: many(eventPlanners),
  attendees: many(attendees),
  travelGroups: many(travelGroups),
  todos: many(organizerTodos),
  packListTemplate: many(packListTemplateItems),
  media: many(media),
  chatMessages: many(chatMessages),
  datePoll: one(datePolls, { fields: [events.id], references: [datePolls.eventId] }),
  // Series: parent event
  episodes: many(events, { relationName: 'series' }),
  parent: one(events, {
    fields: [events.parentId],
    references: [events.id],
    relationName: 'series',
  }),
}))

export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
