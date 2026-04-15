import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  integer,
  boolean,
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { users } from './users.js'
import { events } from './events.js'
import { travelGroupCommitments } from './travel.js'
import { attendeePackItems } from './todos.js'
import { icalTokens } from './ical.js'

export const rsvpStatusEnum = pgEnum('rsvp_status', [
  'yes',
  'maybe',
  'no',
  'cheering',
])

export const attendees = pgTable('attendees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),

  // Registered user (nullable for guests)
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

  // Guest info (used when userId is null)
  guestName: text('guest_name'),
  guestEmail: text('guest_email'),

  // Single-use RSVP token for guest access
  rsvpToken: text('rsvp_token').notNull().$defaultFn(() => createId()),

  rsvpStatus: rsvpStatusEnum('rsvp_status').notNull(),
  plusOne: integer('plus_one').notNull().default(0),

  // Dietary / accessibility
  dietaryNote: text('dietary_note'),
  accessibilityNote: text('accessibility_note'),
  note: text('note'),

  // Travel
  originStation: text('origin_station'),

  // Notifications
  unsubscribed: boolean('unsubscribed').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const attendeesRelations = relations(attendees, ({ one, many }) => ({
  event: one(events, { fields: [attendees.eventId], references: [events.id] }),
  user: one(users, { fields: [attendees.userId], references: [users.id] }),
  travelCommitments: many(travelGroupCommitments),
  packItems: many(attendeePackItems),
  icalToken: one(icalTokens, { fields: [attendees.id], references: [icalTokens.attendeeId] }),
}))

export type Attendee = typeof attendees.$inferSelect
export type NewAttendee = typeof attendees.$inferInsert
