import { relations } from 'drizzle-orm'
import { index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { event } from './events'

export const rsvpStatusEnum = pgEnum('rsvp_status', ['yes', 'maybe', 'no', 'cheering'])

/**
 * A public invite token for an event. One row per event; rotating the invite
 * replaces the `token` value. Tokens are unguessable cuid2 strings.
 */
export const eventInvite = pgTable(
  'event_invite',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    uniqueIndex('event_invite_eventId_uidx').on(table.eventId),
    index('event_invite_token_idx').on(table.token)
  ]
)

/**
 * An attendee — either a registered user (userId set) or a guest
 * (identified by email alone). Each attendee has a personal `rsvpToken`
 * that functions as a magic-link credential for managing their own RSVP.
 */
export const attendee = pgTable(
  'attendee',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    // Nullable for guests (no account).
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    rsvpStatus: rsvpStatusEnum('rsvp_status').notNull(),
    plusOne: integer('plus_one').notNull().default(0),
    dietary: text('dietary'),
    accessibility: text('accessibility'),
    note: text('note'),
    // Which public invite the attendee RSVP'd through (nullable: planner may
    // add an attendee directly, or the invite may be rotated later).
    inviteId: text('invite_id')
      .references(() => eventInvite.id, { onDelete: 'set null' }),
    // Personal, unguessable token for managing this RSVP (magic-link style).
    rsvpToken: text('rsvp_token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('attendee_eventId_idx').on(table.eventId),
    index('attendee_userId_idx').on(table.userId),
    index('attendee_rsvpToken_idx').on(table.rsvpToken),
    // Prevent double-RSVP by the same email for the same event.
    uniqueIndex('attendee_eventId_email_uidx').on(table.eventId, table.email)
  ]
)

export const eventInviteRelations = relations(eventInvite, ({ one, many }) => ({
  event: one(event, {
    fields: [eventInvite.eventId],
    references: [event.id]
  }),
  attendees: many(attendee)
}))

export const attendeeRelations = relations(attendee, ({ one }) => ({
  event: one(event, {
    fields: [attendee.eventId],
    references: [event.id]
  }),
  user: one(user, {
    fields: [attendee.userId],
    references: [user.id]
  }),
  invite: one(eventInvite, {
    fields: [attendee.inviteId],
    references: [eventInvite.id]
  })
}))
