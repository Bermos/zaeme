import {
  pgTable,
  text,
  timestamp,
  pgEnum,
  numeric,
} from 'drizzle-orm/pg-core'
import { createId } from '@paralleldrive/cuid2'
import { relations } from 'drizzle-orm'
import { events } from './events.js'
import { attendees } from './attendees.js'

export const pollResponseEnum = pgEnum('poll_response', [
  'yes',
  'if_need_be',
  'no',
])

export const datePolls = pgTable('date_polls', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('event_id').notNull().unique().references(() => events.id, { onDelete: 'cascade' }),
  question: text('question'),
  deadline: timestamp('deadline', { withTimezone: true }),
  decidedSlotId: text('decided_slot_id'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const datePollSlots = pgTable('date_poll_slots', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pollId: text('poll_id').notNull().references(() => datePolls.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  score: numeric('score', { precision: 10, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const datePollResponses = pgTable('date_poll_responses', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  slotId: text('slot_id').notNull().references(() => datePollSlots.id, { onDelete: 'cascade' }),
  attendeeId: text('attendee_id').notNull().references(() => attendees.id, { onDelete: 'cascade' }),
  response: pollResponseEnum('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const datePollsRelations = relations(datePolls, ({ one, many }) => ({
  event: one(events, { fields: [datePolls.eventId], references: [events.id] }),
  slots: many(datePollSlots),
}))

export const datePollSlotsRelations = relations(datePollSlots, ({ one, many }) => ({
  poll: one(datePolls, { fields: [datePollSlots.pollId], references: [datePolls.id] }),
  responses: many(datePollResponses),
}))

export const datePollResponsesRelations = relations(datePollResponses, ({ one }) => ({
  slot: one(datePollSlots, { fields: [datePollResponses.slotId], references: [datePollSlots.id] }),
  attendee: one(attendees, { fields: [datePollResponses.attendeeId], references: [attendees.id] }),
}))

export type DatePoll = typeof datePolls.$inferSelect
export type NewDatePoll = typeof datePolls.$inferInsert
export type DatePollSlot = typeof datePollSlots.$inferSelect
export type DatePollResponse = typeof datePollResponses.$inferSelect
