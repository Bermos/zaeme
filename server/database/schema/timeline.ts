import { relations } from 'drizzle-orm'
import { index, integer, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { event } from './events'

export const timelineItemTypeEnum = pgEnum('timeline_item_type', [
  'transport',
  'activity',
  'accommodation',
  'meal',
  'other'
])

/**
 * A single point on an event's itinerary timeline.
 *
 * Items are ordered by `sortOrder` (ascending). When two items share the
 * same sortOrder they are secondarily ordered by `startsAt`.
 *
 * `pollId` is a forward-reference to the future `date_poll` table (Phase 4).
 * When set it indicates this item is an *alternative* whose inclusion depends
 * on a poll outcome. The UI renders a "pending poll decision" badge; no
 * further logic is needed until Phase 4.
 */
export const timelineItem = pgTable(
  'timeline_item',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    location: text('location'),
    type: timelineItemTypeEnum('type').notNull().default('other'),
    // Heroicons / Lucide icon slug override — falls back to type default when null
    icon: text('icon'),
    sortOrder: integer('sort_order').notNull().default(0),
    // Forward-reference for Phase 4 date polls (nullable until that table exists)
    pollId: text('poll_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('timeline_item_eventId_idx').on(table.eventId),
    index('timeline_item_sortOrder_idx').on(table.eventId, table.sortOrder)
  ]
)

export const timelineItemRelations = relations(timelineItem, ({ one }) => ({
  event: one(event, {
    fields: [timelineItem.eventId],
    references: [event.id]
  })
}))
