import { relations } from 'drizzle-orm'
import { bigint, boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * The events domain tables, namespaced `events_*`. zäme owns this schema and
 * the Postgres it lives in: the app is a single standalone deployable again,
 * so there is no shared database, no cross-department reader and no ontology.
 *
 * History: these tables started life in this repo as
 * `server/database/schema/{events,rsvp,ical,media,timeline}.ts`, spent 2026-07
 * through 2026-09 inside the Enterprise monorepo as `@enterprise/events-core`,
 * and came home with every improvement made there. Two conventions survive
 * that trip and are kept deliberately:
 *
 *  - Table names carry the `events_` prefix; the JS export names drop it, so
 *    the domain logic reads cleanly (`tables.event`, `tables.rsvp`, …).
 *  - Enum-ish columns are `text({ enum })` rather than real Postgres enums —
 *    same TS-level union, far simpler migrations.
 *
 * GUEST IDENTITY rides on the lowercased email address, everywhere: an RSVP is
 * unique per (event, email), a date vote per (option, email), a series
 * membership per (series, email). A `zaeme_user` account (magic link, see
 * ./auth.ts) is optional and only unlocks the cross-event `/me` aggregation.
 * The `person_id` columns that used to soft-link into `ontology_person` are
 * gone with the monorepo — nothing read them here.
 *
 * The surface, table by table:
 *  - `events_event` — the gathering. `type` covers hosted nights, concerts, a
 *    `series` container, `trip` (multi-day, itinerary + budget) and `party`
 *    (two-stage: a core group fixes the date, then everyone signs up).
 *  - `events_invite` / `events_rsvp` — the capability link and the answer;
 *    `invite.tier` marks the party phases (`core` poll wave vs `general`).
 *  - `events_date_option` + `events_date_vote` — the date-finding poll.
 *  - `events_contribution` — the bring list (food & drink coordination).
 *  - `events_timeline_item` — the itinerary.
 *  - `events_media` — the shared gallery, documents and tickets.
 *  - `events_series_member` — the standing group of a recurring series: each
 *    new occurrence auto-invites every member.
 *  - `events_expense` + `events_expense_share` — the trip budget (integer
 *    cents; no float money).
 *  - `events_message` — the per-event group chat.
 *  - `events_event_planner` + `events_planner_invite` — co-organizers.
 *  - `events_ical_token` — the per-attendee calendar-feed credential.
 */
export const event = pgTable('events_event', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  type: text('type', { enum: ['hosted', 'concert', 'series', 'trip', 'party'] }).notNull().default('hosted'),
  status: text('status', { enum: ['draft', 'polling', 'published', 'completed', 'cancelled'] }).notNull().default('draft'),
  description: text('description'),
  /** Hero/poster image URL — the "what are we watching" post (zäme movie night). */
  posterUrl: text('poster_url'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  location: text('location'),
  venueStation: text('venue_station'),
  // Concert-specific fields
  ticketUrl: text('ticket_url'),
  performerNote: text('performer_note'),
  // Visibility
  isPublic: boolean('is_public').notNull().default(false),
  // Series support (soft self-reference)
  parentId: text('parent_id'),
  /** Human cadence note for a series container, e.g. "every second Friday". */
  cadence: text('cadence'),
  /**
   * The id this event is a PROJECTION of, in the system that owns the record of
   * truth — today only Enterprise's `music_concert.id`, arriving through
   * `POST /api/v1/concerts/publish` (ADR-0036). It is the idempotency key for
   * that operation: a republish resolves the same announcement through this
   * column, so the caller's own remembered event id stays advisory and a stale
   * one cannot mint a duplicate. Unique where present; null for everything
   * planned in zäme itself.
   */
  externalRef: text('external_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_event_slug_idx').on(table.slug),
  index('events_event_status_idx').on(table.status),
  index('events_event_parent_idx').on(table.parentId),
  index('events_event_starts_at_idx').on(table.startsAt),
  uniqueIndex('events_event_external_ref_unique').on(table.externalRef)
])

export const eventPlanner = pgTable('events_event_planner', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  role: text('role', { enum: ['owner', 'co_planner', 'logistics'] }).notNull().default('co_planner'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_event_planner_event_idx').on(table.eventId),
  index('events_event_planner_user_idx').on(table.userId)
])

export const invite = pgTable('events_invite', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  label: text('label'),
  email: text('email'),
  name: text('name'),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').notNull().default(0),
  /**
   * Party phasing (two-stage planning): `core` invites are the small group
   * that fixes the date in the poll; `general` is the wider wave invited once
   * the date is locked. Non-party events just use the default.
   */
  tier: text('tier', { enum: ['core', 'general'] }).notNull().default('general'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdByUserId: text('created_by_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_invite_event_idx').on(table.eventId),
  index('events_invite_email_idx').on(table.email)
])

export const rsvp = pgTable('events_rsvp', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  inviteId: text('invite_id').references(() => invite.id, { onDelete: 'set null' }),
  userId: text('user_id'),
  guestName: text('guest_name'),
  guestEmail: text('guest_email'),
  status: text('status', { enum: ['yes', 'maybe', 'no', 'cheering'] }).notNull(),
  plusOne: boolean('plus_one').notNull().default(false),
  plusOneName: text('plus_one_name'),
  dietary: text('dietary'),
  accessibility: text('accessibility'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_rsvp_event_idx').on(table.eventId),
  index('events_rsvp_user_idx').on(table.userId),
  index('events_rsvp_guest_email_idx').on(table.guestEmail),
  uniqueIndex('events_rsvp_event_user_unique').on(table.eventId, table.userId),
  uniqueIndex('events_rsvp_event_email_unique').on(table.eventId, table.guestEmail)
])

export const timelineItem = pgTable('events_timeline_item', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  location: text('location'),
  type: text('type', { enum: ['transport', 'activity', 'accommodation', 'meal', 'other'] }).notNull().default('other'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  pollId: text('poll_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_timeline_item_event_idx').on(table.eventId),
  index('events_timeline_item_sort_idx').on(table.eventId, table.sortOrder)
])

export const media = pgTable('events_media', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  type: text('type', { enum: ['photo', 'video', 'document', 'ticket'] }).notNull(),
  status: text('status', { enum: ['pending', 'ready'] }).notNull().default('pending'),
  storageKey: text('storage_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  fileName: text('file_name').notNull(),
  caption: text('caption'),
  takenAt: timestamp('taken_at', { withTimezone: true }),
  uploadedByUserId: text('uploaded_by_user_id'),
  uploadedByRsvpId: text('uploaded_by_rsvp_id').references(() => rsvp.id, { onDelete: 'set null' }),
  assignedRsvpId: text('assigned_rsvp_id').references(() => rsvp.id, { onDelete: 'set null' }),
  timelineItemId: text('timeline_item_id').references(() => timelineItem.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_media_event_idx').on(table.eventId),
  index('events_media_type_idx').on(table.type),
  index('events_media_status_idx').on(table.status),
  index('events_media_taken_at_idx').on(table.takenAt),
  index('events_media_assigned_rsvp_idx').on(table.assignedRsvpId),
  index('events_media_timeline_item_idx').on(table.timelineItemId)
])

export const icalToken = pgTable('events_ical_token', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: text('user_id'),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_ical_token_user_idx').on(table.userId),
  index('events_ical_token_email_idx').on(table.email),
  uniqueIndex('events_ical_token_user_unique').on(table.userId),
  uniqueIndex('events_ical_token_email_unique').on(table.email)
])

/* ----------------------- date-finding availability poll ------------------- */

/**
 * A proposed date/time for an event in `polling` status. The host proposes
 * several; participants vote on each; the host locks the winner (which stamps
 * `event.startsAt/endsAt` and transitions polling → published).
 */
export const dateOption = pgTable('events_date_option', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  note: text('note'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_date_option_event_idx').on(table.eventId)
])

/**
 * One participant's availability for one proposed date. Identity is the same
 * name+email pair RSVPs use; one vote per
 * (option, email). `ifneedbe` is the when2meet-style "if I must".
 */
export const dateVote = pgTable('events_date_vote', {
  id: text('id').primaryKey(),
  optionId: text('option_id').notNull().references(() => dateOption.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  guestName: text('guest_name').notNull(),
  guestEmail: text('guest_email').notNull(),
  answer: text('answer', { enum: ['yes', 'ifneedbe', 'no'] }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_date_vote_option_idx').on(table.optionId),
  index('events_date_vote_event_idx').on(table.eventId),
  index('events_date_vote_email_idx').on(table.guestEmail),
  uniqueIndex('events_date_vote_option_email_unique').on(table.optionId, table.guestEmail)
])

/* ------------------------------ bring list -------------------------------- */

/**
 * The bring list ("who brings what"): items the host or guests add and guests
 * claim. Unclaimed = `claimedByEmail` null. Claimers use the same name+email
 * identity as RSVPs/votes.
 */
export const contribution = pgTable('events_contribution', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  category: text('category', { enum: ['food', 'drink', 'other'] }).notNull().default('other'),
  quantity: text('quantity'),
  note: text('note'),
  claimedByName: text('claimed_by_name'),
  claimedByEmail: text('claimed_by_email'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  /** Who added the item: a planner's userId, or a guest's email. */
  createdByUserId: text('created_by_user_id'),
  createdByGuestEmail: text('created_by_guest_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_contribution_event_idx').on(table.eventId),
  index('events_contribution_claimed_email_idx').on(table.claimedByEmail)
])

/* ------------------------------ series group ------------------------------ */

/**
 * The standing group of a recurring series (movie nights): people who said
 * "count me in for these, generally". Each scheduled occurrence creates a
 * personalised invite per member — signing up per showing is the RSVP, so a
 * series never runs a date poll. Same name+email identity as RSVPs.
 */
export const seriesMember = pgTable('events_series_member', {
  id: text('id').primaryKey(),
  /** The series container event (`event.type = 'series'`). */
  seriesId: text('series_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdByUserId: text('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_series_member_series_idx').on(table.seriesId),
  uniqueIndex('events_series_member_series_email_unique').on(table.seriesId, table.email)
])

/* ----------------------------- budget / splitting -------------------------- */

/**
 * One paid cost on an event (trips mostly): who paid, how much, and how it is
 * split. Money is integer cents (no float money); `currency` is informative —
 * balances are only computed within one currency.
 */
export const expense = pgTable('events_expense', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  category: text('category', { enum: ['travel', 'accommodation', 'food', 'tickets', 'other'] }).notNull().default('other'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('CHF'),
  /** Who fronted the money — same name+email identity as RSVPs. */
  paidByName: text('paid_by_name').notNull(),
  paidByEmail: text('paid_by_email').notNull(),
  note: text('note'),
  /** Who recorded it: a planner's userId, or a guest's email. */
  createdByUserId: text('created_by_user_id'),
  createdByGuestEmail: text('created_by_guest_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_expense_event_idx').on(table.eventId),
  index('events_expense_paid_by_email_idx').on(table.paidByEmail)
])

/**
 * One participant's slice of an expense. Shares are materialised amounts (the
 * even-split remainder distribution happens at write time), so balances are a
 * plain sum — no split-mode arithmetic at read time.
 */
export const expenseShare = pgTable('events_expense_share', {
  id: text('id').primaryKey(),
  expenseId: text('expense_id').notNull().references(() => expense.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  amountCents: integer('amount_cents').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('events_expense_share_expense_idx').on(table.expenseId),
  index('events_expense_share_event_idx').on(table.eventId),
  index('events_expense_share_email_idx').on(table.email),
  uniqueIndex('events_expense_share_expense_email_unique').on(table.expenseId, table.email)
])

/* -------------------------------- group chat ------------------------------- */

/**
 * The per-event group chat ("who's driving?", "I'll be 10 late"). Authors are
 * the same name+email identity as RSVPs; a planner posting from the host side
 * additionally carries their userId so the UI can badge the host.
 */
export const message = pgTable('events_message', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  authorName: text('author_name').notNull(),
  authorEmail: text('author_email').notNull(),
  /** Set when a planner posted from the host surface (badge as host). */
  authorUserId: text('author_user_id'),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('events_message_event_idx').on(table.eventId, table.createdAt)
])

/* ---------------------------- co-organizer invites ------------------------- */

/**
 * Co-organizer onboarding: a capability link the host shares; another zäme
 * account opens it, signs in, and accepts — becoming an `events_event_planner`
 * row on the event. Kept separate from guest invites because the grant is a
 * planning role, not attendance.
 */
export const plannerInvite = pgTable('events_planner_invite', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  /** Optional restriction: only a session with this email may accept. */
  email: text('email'),
  role: text('role', { enum: ['co_planner', 'logistics'] }).notNull().default('co_planner'),
  createdByUserId: text('created_by_user_id').notNull(),
  acceptedByUserId: text('accepted_by_user_id'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_planner_invite_event_idx').on(table.eventId)
])

/**
 * Relation hooks for the RSVP, so a read can pull the event and the invite it
 * came through in one query.
 */
export const rsvpRelations = relations(rsvp, ({ one }) => ({
  event: one(event, { fields: [rsvp.eventId], references: [event.id] }),
  invite: one(invite, { fields: [rsvp.inviteId], references: [invite.id] })
}))

/** The domain's schema object, composed into the one Drizzle setup. */
export const eventsSchema = {
  event,
  eventPlanner,
  invite,
  rsvp,
  timelineItem,
  media,
  icalToken,
  dateOption,
  dateVote,
  contribution,
  seriesMember,
  expense,
  expenseShare,
  message,
  plannerInvite
}
