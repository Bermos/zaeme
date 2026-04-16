import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'
import { events } from './events'

export const travelGroups = pgTable('travel_groups', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  hubStation: text('hub_station').notNull(), // shared departure/hub station for the group
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const travelGroupCommitments = pgTable('travel_group_commitments', {
  id: text('id').primaryKey(),
  travelGroupId: text('travel_group_id').notNull().references(() => travelGroups.id, { onDelete: 'cascade' }),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  committed: boolean('committed').notNull().default(false), // true when attendee confirms "I'm taking this train"
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
