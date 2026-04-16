import { boolean, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { events } from './events'
import { user } from './users'

export const rsvpStatusEnum = pgEnum('rsvp_status', ['yes', 'maybe', 'no', 'cheering'])

export const attendees = pgTable('attendees', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => user.id, { onDelete: 'set null' }), // nullable — guests have no account
  name: text('name').notNull(),
  email: text('email').notNull(),
  rsvpStatus: rsvpStatusEnum('rsvp_status'),
  plusOne: boolean('plus_one').notNull().default(false),
  dietary: text('dietary'),
  accessibility: text('accessibility'),
  note: text('note'),
  originStation: text('origin_station'), // SBB station for travel group clustering
  rsvpToken: text('rsvp_token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
