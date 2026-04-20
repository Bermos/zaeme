import { relations } from 'drizzle-orm'
import { boolean, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth'
import { event } from './events'

export const rsvpStatusEnum = pgEnum('rsvp_status', ['yes', 'maybe', 'no', 'cheering'])

/**
 * Per-event invite token. An invite can be:
 *   - Targeted (email set) — personalised for one recipient.
 *   - Shareable (email null) — typical `maxUses=null` link for general distribution.
 *
 * Treat the token as a credential (unguessable cuid2).
 */
export const invite = pgTable(
  'invite',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    label: text('label'),
    email: text('email'),
    name: text('name'),
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
    index('invite_eventId_idx').on(table.eventId),
    index('invite_email_idx').on(table.email)
  ]
)

/**
 * One RSVP per attendee per event. Either `userId` (registered) or
 * `guestEmail` (guest) identifies the attendee.
 */
export const rsvp = pgTable(
  'rsvp',
  {
    id: text('id').primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    inviteId: text('invite_id')
      .references(() => invite.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .references(() => user.id, { onDelete: 'set null' }),
    guestName: text('guest_name'),
    guestEmail: text('guest_email'),
    status: rsvpStatusEnum('status').notNull(),
    plusOne: boolean('plus_one').notNull().default(false),
    plusOneName: text('plus_one_name'),
    dietary: text('dietary'),
    accessibility: text('accessibility'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull()
  },
  table => [
    index('rsvp_eventId_idx').on(table.eventId),
    index('rsvp_userId_idx').on(table.userId),
    index('rsvp_guestEmail_idx').on(table.guestEmail),
    uniqueIndex('rsvp_event_user_unique').on(table.eventId, table.userId),
    uniqueIndex('rsvp_event_email_unique').on(table.eventId, table.guestEmail)
  ]
)

export const inviteRelations = relations(invite, ({ one, many }) => ({
  event: one(event, {
    fields: [invite.eventId],
    references: [event.id]
  }),
  createdBy: one(user, {
    fields: [invite.createdByUserId],
    references: [user.id]
  }),
  rsvps: many(rsvp)
}))

export const rsvpRelations = relations(rsvp, ({ one }) => ({
  event: one(event, {
    fields: [rsvp.eventId],
    references: [event.id]
  }),
  invite: one(invite, {
    fields: [rsvp.inviteId],
    references: [invite.id]
  }),
  user: one(user, {
    fields: [rsvp.userId],
    references: [user.id]
  })
}))
