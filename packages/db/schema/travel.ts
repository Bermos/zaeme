import { pgTable, text, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { events } from './events.js'
import { attendees } from './attendees.js'

export const travelCommitmentStatusEnum = pgEnum('travel_commitment_status', [
  'pending',
  'confirmed',
  'declined',
])

// Clustered travel groups (SBB connection groups)
export const travelGroups = pgTable('travel_groups', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  hubStation: text('hub_station').notNull(),

  // Cached SBB connection details (JSON array of connection legs)
  connectionData: jsonb('connection_data'),

  trainNumber: text('train_number'),
  departureTime: timestamp('departure_time', { withTimezone: true }),
  arrivalTime: timestamp('arrival_time', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Attendee commitment to a specific travel group
export const travelGroupCommitments = pgTable('travel_group_commitments', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  travelGroupId: text('travel_group_id').notNull().references(() => travelGroups.id, { onDelete: 'cascade' }),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  isTaking: travelCommitmentStatusEnum('is_taking').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const travelGroupsRelations = relations(travelGroups, ({ one, many }) => ({
  event: one(events, { fields: [travelGroups.eventId], references: [events.id] }),
  commitments: many(travelGroupCommitments),
}))

export const travelGroupCommitmentsRelations = relations(travelGroupCommitments, ({ one }) => ({
  travelGroup: one(travelGroups, {
    fields: [travelGroupCommitments.travelGroupId],
    references: [travelGroups.id],
  }),
  attendee: one(attendees, {
    fields: [travelGroupCommitments.attendeeId],
    references: [attendees.id],
  }),
}))

export type TravelGroup = typeof travelGroups.$inferSelect
export type NewTravelGroup = typeof travelGroups.$inferInsert
export type TravelGroupCommitment = typeof travelGroupCommitments.$inferSelect
