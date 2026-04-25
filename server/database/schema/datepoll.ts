import { relations } from 'drizzle-orm'
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { event } from './events'
import { invite } from './rsvp'

/**
 * Three-way response on a candidate slot. Mirrors the classic Doodle UX —
 * `if_need_be` is a soft yes that contributes 0.5 to the slot's score so
 * planners can tell apart enthusiastic from grudging availability.
 */
export const datePollResponseEnum = pgEnum('date_poll_response', ['yes', 'if_need_be', 'no'])

/**
 * One open date poll per event. Created while the event is in `polling`
 * status; closed (manually or by the `datepoll.closed` Inngest job at the
 * `deadline`) when the planner picks a winning slot.
 *
 * `decidedSlotId` is set when a slot is chosen — the planner action also
 * promotes its `startsAt`/`endsAt` onto the event row and transitions the
 * event from `polling` to `published`.
 */
export const datePoll = pgTable(
  'date_poll',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    /** Optional prompt shown to voters, e.g. "Which weekend works for you?" */
    question: text('question'),
    /** When the poll auto-closes. `null` = no auto-close, planner closes manually. */
    deadline: timestamp('deadline', { withTimezone: true }),
    /** Set once a winning slot is decided — see `datePollSlot.id`. */
    decidedSlotId: text('decided_slot_id'),
    /** Set when the poll is closed (manually or by deadline). */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    // One open poll per event keeps the planner UX unambiguous.
    uniqueIndex('date_poll_event_unique').on(table.eventId)
  ]
)

/**
 * A candidate time-slot on a poll. Slots have a hard `startsAt`; `endsAt`
 * is optional and falls back to a 2-hour default at promotion time.
 */
export const datePollSlot = pgTable(
  'date_poll_slot',
  {
    id: text('id').primaryKey(),
    pollId: text('poll_id')
      .notNull()
      .references(() => datePoll.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('date_poll_slot_pollId_idx').on(table.pollId),
    index('date_poll_slot_sortOrder_idx').on(table.pollId, table.sortOrder, table.startsAt)
  ]
)

/**
 * One per (slot, voter). Voter identity mirrors `rsvp` — either a
 * registered `userId` or a guest pair (`guestEmail`, `guestName`). The
 * unique indexes prevent a single voter from voting twice on the same slot.
 *
 * `inviteId` is recorded for traceability and to allow notifying the right
 * recipient when the poll is decided.
 */
export const datePollResponse = pgTable(
  'date_poll_response',
  {
    id: text('id').primaryKey(),
    pollId: text('poll_id')
      .notNull()
      .references(() => datePoll.id, { onDelete: 'cascade' }),
    slotId: text('slot_id')
      .notNull()
      .references(() => datePollSlot.id, { onDelete: 'cascade' }),
    inviteId: text('invite_id')
      .references(() => invite.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'set null' }),
    guestName: text('guest_name'),
    guestEmail: text('guest_email'),
    response: datePollResponseEnum('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('date_poll_response_pollId_idx').on(table.pollId),
    index('date_poll_response_slotId_idx').on(table.slotId),
    uniqueIndex('date_poll_response_slot_user_unique').on(table.slotId, table.userId),
    uniqueIndex('date_poll_response_slot_email_unique').on(table.slotId, table.guestEmail)
  ]
)

export const datePollRelations = relations(datePoll, ({ one, many }) => ({
  event: one(event, {
    fields: [datePoll.eventId],
    references: [event.id]
  }),
  createdBy: one(user, {
    fields: [datePoll.createdByUserId],
    references: [user.id]
  }),
  slots: many(datePollSlot),
  responses: many(datePollResponse)
}))

export const datePollSlotRelations = relations(datePollSlot, ({ one, many }) => ({
  poll: one(datePoll, {
    fields: [datePollSlot.pollId],
    references: [datePoll.id]
  }),
  responses: many(datePollResponse)
}))

export const datePollResponseRelations = relations(datePollResponse, ({ one }) => ({
  poll: one(datePoll, {
    fields: [datePollResponse.pollId],
    references: [datePoll.id]
  }),
  slot: one(datePollSlot, {
    fields: [datePollResponse.slotId],
    references: [datePollSlot.id]
  }),
  invite: one(invite, {
    fields: [datePollResponse.inviteId],
    references: [invite.id]
  }),
  user: one(user, {
    fields: [datePollResponse.userId],
    references: [user.id]
  })
}))
