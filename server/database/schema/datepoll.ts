import { pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { attendees } from './attendees'
import { events } from './events'

export const datePollResponseEnum = pgEnum('date_poll_response', ['yes', 'if_need_be', 'no'])

// datePollSlots is defined first so datePolls.decidedSlotId can reference it directly
export const datePollSlots = pgTable('date_poll_slots', {
  id: text('id').primaryKey(),
  pollId: text('poll_id').notNull().references(() => datePolls.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const datePolls = pgTable('date_polls', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().unique().references(() => events.id, { onDelete: 'cascade' }),
  question: text('question'),
  deadline: timestamp('deadline', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  decidedSlotId: text('decided_slot_id').references(() => datePollSlots.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})

export const datePollResponses = pgTable('date_poll_responses', {
  id: text('id').primaryKey(),
  slotId: text('slot_id').notNull().references(() => datePollSlots.id, { onDelete: 'cascade' }),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  response: datePollResponseEnum('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
})
