import { relations } from 'drizzle-orm'
import { boolean, index, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { user } from './auth'

export const eventTypeEnum = pgEnum('event_type', ['hosted', 'concert', 'series'])
export const eventStatusEnum = pgEnum('event_status', ['draft', 'polling', 'published', 'completed', 'cancelled'])

export const event = pgTable(
  'event',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    type: eventTypeEnum('type').notNull().default('hosted'),
    status: eventStatusEnum('status').notNull().default('draft'),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    location: text('location'),
    venueStation: text('venue_station'),
    // Concert-specific fields
    ticketUrl: text('ticket_url'),
    performerNote: text('performer_note'),
    // Visibility
    isPublic: boolean('is_public').notNull().default(false),
    // Series support
    parentId: text('parent_id'),
    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('event_slug_idx').on(table.slug),
    index('event_status_idx').on(table.status),
    index('event_parentId_idx').on(table.parentId)
  ]
)

export const eventPlanner = pgTable(
  'event_planner',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'co_planner', 'logistics'] })
      .notNull()
      .default('co_planner'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('event_planner_eventId_idx').on(table.eventId),
    index('event_planner_userId_idx').on(table.userId)
  ]
)

export const eventRelations = relations(event, ({ many, one }) => ({
  planners: many(eventPlanner),
  parent: one(event, {
    fields: [event.parentId],
    references: [event.id],
    relationName: 'episodes'
  }),
  episodes: many(event, { relationName: 'episodes' })
}))

export const eventPlannerRelations = relations(eventPlanner, ({ one }) => ({
  event: one(event, {
    fields: [eventPlanner.eventId],
    references: [event.id]
  }),
  user: one(user, {
    fields: [eventPlanner.userId],
    references: [user.id]
  })
}))
