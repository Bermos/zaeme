import { relations, sql } from 'drizzle-orm'
import { bigint, boolean, check, foreignKey, index, integer, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

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
 *  - `events_place` + `events_itinerary_leg` — the GEOGRAPHY of a trip (#30):
 *    the places an itinerary happens at (coordinates optional — a place can be
 *    typed by hand and never geocoded) and the connections between them, which
 *    is the thing an itinerary of sorted strings could not express. A leg
 *    records whether it is the 09:14 somebody INTENDS to take or the bus they
 *    actually got on.
 *  - `events_media` — the shared gallery, documents and tickets.
 *  - `events_series_member` — the standing group of a recurring series: each
 *    new occurrence auto-invites every member.
 *  - `events_account` + `events_expense` + `events_expense_share` — the trip
 *    budget, kept as a DOUBLE-ENTRY LEDGER (#61): accounts per member, per
 *    category and one for rounding; `events_expense` is a journal entry and
 *    `events_expense_share` its lines, which sum to zero. Integer cents; no
 *    float money. Each entry carries the base currency and the FX rate it was
 *    recorded at.
 *  - `events_instance_setting` — the one-row instance configuration (the base
 *    currency the whole instance settles up in).
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
  /**
   * The place this item happens at, when somebody has pinned one (#30).
   *
   * NULLABLE AND STAYING THAT WAY, and `location` above is not going anywhere
   * either: an itinerary item typed as "Ana's flat" has no place, no
   * coordinates and no reason to acquire either, and that is the ordinary case
   * for every event that is not a trip. An item with no place renders from
   * `location` exactly as it did before this column existed.
   *
   * `on delete set null` rather than a cascade: deleting a place must not
   * delete the plan. The item keeps its free-text `location` and simply stops
   * pointing at a pin.
   *
   * A plain reference, not the composite `(event_id, place_id)` the legs below
   * carry, because `on delete set null` on a composite key would try to null
   * `event_id` too (Postgres 15's `SET NULL (column_list)` is not something
   * drizzle-kit emits). `addTimelineItem`/`applyTimelineItemUpdate` check the
   * place belongs to this event instead — see `assertPlaceOnEvent` in
   * `server/domain/places.ts`.
   */
  placeId: text('place_id').references(() => place.id, { onDelete: 'set null' }),
  type: text('type', { enum: ['transport', 'activity', 'accommodation', 'meal', 'other'] }).notNull().default('other'),
  icon: text('icon'),
  sortOrder: integer('sort_order').notNull().default(0),
  pollId: text('poll_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_timeline_item_event_idx').on(table.eventId),
  index('events_timeline_item_sort_idx').on(table.eventId, table.sortOrder),
  index('events_timeline_item_place_idx').on(table.placeId)
])

/* --------------------- places, and the legs between them ------------------- */

/**
 * A PLACE on one event's map (#30): the hotel, the trailhead, the restaurant
 * somebody found. Before this, an itinerary was a sorted list of strings with
 * one free-text `location` each — no pin, no coordinate, and nothing two items
 * could share.
 *
 * A PLACE WITH NO COORDINATES IS A FIRST-CLASS STATE, not a half-filled row.
 * "Ana's flat" and "the usual spot by the lake" are places a group names and
 * never geocodes, and the geocoding search (#32) has to be able to leave them
 * alone. So `lat`/`lng` are nullable — together, never one of them: half a
 * coordinate is not a location, and `addPlace` refuses it rather than storing
 * a number nothing can use. Coordinates can be added later, which is the whole
 * point of them being nullable rather than required.
 *
 * `osm_type`/`osm_id` are where a geocoded place records WHAT IT MATCHED, so
 * #32 can tell "we looked this up" from "somebody typed it". Both null on a
 * hand-typed place. They are deliberately NOT unique per event: whether
 * looking up the same café twice is a duplicate to be merged or two pins the
 * group meant is #32's decision, not this one's.
 *
 * WHY `numeric(9, 6)` AND NOT A FLOAT OR A STRING. Six decimal places is about
 * 11 cm at the equator — far finer than anything a trip planner needs, and the
 * precision Nominatim answers with. `numeric` stores what was typed EXACTLY, so
 * a coordinate round-trips unchanged through an edit instead of acquiring a
 * seventeenth digit; it sorts and indexes, so "the places inside this bounding
 * box" is an ordinary range query; and arithmetic that genuinely needs floating
 * point — a haversine distance, the clustering that #33 wants so a day's stops
 * can be the ones near each other — casts to `float8` at the point of use,
 * which is what the trig functions take anyway. Three integer digits is exactly
 * enough for a longitude (-180..180) and two more than a latitude needs.
 *
 * `created_by_user_id` and no guest twin: places are created on the host
 * surface only. A `created_by_guest_email` here would be a column nothing ever
 * writes, which is the shape of the `events_expense.currency` bug (#25) —
 * stored, typed, rendered and read by nothing. Guests add LEGS, and the audit
 * records the invite that added one.
 */
export const place = pgTable('events_place', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /** What the group calls it — "Hotel Bellevue", "the trailhead". */
  name: text('name').notNull(),
  /** The postal address, when there is one. */
  address: text('address'),
  /** Both or neither; see the note above. Degrees, WGS84. */
  lat: numeric('lat', { precision: 9, scale: 6 }),
  lng: numeric('lng', { precision: 9, scale: 6 }),
  /** What a geocoded place matched in OpenStreetMap. Null when hand-typed. */
  osmType: text('osm_type', { enum: ['node', 'way', 'relation'] }),
  osmId: text('osm_id'),
  note: text('note'),
  createdByUserId: text('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_place_event_idx').on(table.eventId),
  // The target of the composite foreign keys on a leg: it is what lets the
  // database refuse a leg on one trip that ends at another trip's place.
  uniqueIndex('events_place_event_id_unique').on(table.eventId, table.id),
  // BOTH OR NEITHER, enforced here and not only in `normaliseCoordinates`.
  // Two functions write this pair today and #32's geocoder will be a third; a
  // half-coordinate row is also UNREPAIRABLE from the product, because the edit
  // form sends the pair back and the domain then refuses every save of that
  // place, including a pure rename, while the screen says "no coordinates yet"
  // and explains nothing. One line on an empty table now, a data-cleanup
  // migration later.
  check('events_place_coordinates_pair', sql`(lat is null) = (lng is null)`)
])

/**
 * A LEG: how you get from one place to another (#30) — the edge the itinerary
 * never had. "Zug → Lugano, the 09:14" is a leg; so is "we ended up walking",
 * which is the half of this that arrives from a guest while the host is asleep.
 *
 * `is_planned` is the difference between those two, and it is the reason this
 * table exists rather than another timeline item: the 09:14 we INTEND to take
 * and the bus we ACTUALLY got on are both worth keeping, and one does not
 * replace the other. The host surface defaults it to true (it is planning) and
 * the guest surface to false (it is reporting) — see the two handlers.
 *
 * ENDPOINTS ARE NULLABLE COLUMNS THAT THE API REQUIRES. Both `from_place_id`
 * and `to_place_id` are set on every leg anyone can write; they are nullable so
 * that deleting a place has somewhere to put the hole. `deletePlace`
 * (`server/domain/places.ts`) nulls the endpoints that pointed at it and
 * removes outright any leg whose BOTH ends were that place, in one transaction
 * — so a dangling id is impossible and a leg never quietly becomes a journey
 * from nowhere to nowhere.
 *
 * The foreign keys are therefore `restrict` and COMPOSITE: `(event_id,
 * place_id)` against `events_place(event_id, id)`, which is what stops a leg on
 * one trip from ending at another trip's place — unreachable through today's
 * handlers, and cheaper for the database to refuse than for every future caller
 * to remember. `restrict` is what makes the deletion order above explicit
 * rather than silent.
 *
 * `sort_order` is the same mechanism the itinerary uses, deliberately: it is
 * renumbered from the display order in ONE statement by
 * `applyItineraryLegMove`, never by two PATCHes that swap a pair of numbers.
 * See `applyTimelineItemMove` in `server/domain/events-data.ts` for why that
 * shape is not a style preference.
 */
export const itineraryLeg = pgTable('events_itinerary_leg', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  fromPlaceId: text('from_place_id'),
  toPlaceId: text('to_place_id'),
  mode: text('mode', { enum: ['walk', 'bike', 'car', 'train', 'bus', 'ferry', 'plane', 'other'] }).notNull(),
  /** Nullable: "we walked back at some point" is a leg with no clock on it. */
  departsAt: timestamp('departs_at', { withTimezone: true }),
  arrivesAt: timestamp('arrives_at', { withTimezone: true }),
  /** How long it takes, when that is known without two timestamps. */
  durationMinutes: integer('duration_minutes'),
  note: text('note'),
  /**
   * THE MANUAL ORDER AMONG LEGS WITH NO DEPARTURE TIME, and nothing else.
   *
   * An itinerary is chronological: a leg that says when it leaves is placed by
   * its clock, on the host card and on the guest page alike, because nobody
   * will accept 11:00 displayed above 09:00 whatever was clicked. So the
   * up/down arrows act on the untimed legs — "we walked back at some point" —
   * and `applyItineraryLegMove` refuses to move a timed one rather than
   * renumbering something no screen reads.
   *
   * A timed leg therefore keeps whatever number it was created with and that
   * number means nothing; it is not part of the sequence the arrows renumber.
   */
  sortOrder: integer('sort_order').notNull().default(0),
  /** The 09:14 we intend to take (true) vs the bus we actually got on (false). */
  isPlanned: boolean('is_planned').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_itinerary_leg_event_idx').on(table.eventId),
  index('events_itinerary_leg_sort_idx').on(table.eventId, table.sortOrder),
  index('events_itinerary_leg_from_idx').on(table.fromPlaceId),
  index('events_itinerary_leg_to_idx').on(table.toPlaceId),
  foreignKey({
    columns: [table.eventId, table.fromPlaceId],
    foreignColumns: [place.eventId, place.id],
    name: 'events_itinerary_leg_event_from_place_fk'
  }).onDelete('restrict'),
  foreignKey({
    columns: [table.eventId, table.toPlaceId],
    foreignColumns: [place.eventId, place.id],
    name: 'events_itinerary_leg_event_to_place_fk'
  }).onDelete('restrict'),
  // A leg goes between two DIFFERENT places. `insertLeg` refuses one that does
  // not, and this is what keeps that true of a row written any other way — the
  // deletion rule below leans on it: "both ends were this place" is a case that
  // cannot arise, which is why a leg is removed only when it loses its LAST
  // endpoint. The `is null` arm is what lets a deleted place null one end.
  check(
    'events_itinerary_leg_distinct_endpoints',
    sql`from_place_id is null or from_place_id <> to_place_id`
  )
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
 * THE CHART OF ACCOUNTS for one event (#61). Three kinds, and no more — this is
 * a friend-group budget, not a general ledger, so there are no assets, no
 * liabilities and no trial balance.
 *
 *  - `member` — one per person who touches money on this event, created on
 *    first use of their identity. It carries the LOWERCASED EMAIL that is
 *    already the identity everywhere else in this domain, so a line no longer
 *    repeats a name and an address per row.
 *  - `category` — where a cost lands. Seeded per event from the enum
 *    `events_expense.category` used to hold, plus `Uncategorised`, which is the
 *    DEFAULT DESTINATION: a group that never wants categories never meets the
 *    concept, and every line still posts somewhere. More can be added within an
 *    event; `Uncategorised` is `is_system` and is never deletable.
 *  - `rounding` — one per event, `is_system`. The home for the cents that
 *    converting a split at one rate leaves over. It exists so an entry can
 *    always balance without the residual being shoved onto the largest creditor
 *    by hand, which is arbitrary and unexplainable to whoever finds it later.
 *
 * WHY AN `email` COLUMN THAT IS NULL ON TWO OF THE THREE KINDS: it is the
 * identity of a member account and there is nothing to be null ABOUT on a
 * category. That is different from `events_expense.currency` before #25 — a
 * value stored, typed and rendered on every row while nothing read it. Here the
 * partial unique index below is what enforces "one account per person per
 * event", and it is only meaningful on the rows that have one.
 */
export const account = pgTable('events_account', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['member', 'category', 'rounding'] }).notNull(),
  /** What it is called on screen. Category names are the ones people rename. */
  name: text('name').notNull(),
  /** Lowercased, member accounts only — the identity RSVPs already use. */
  email: text('email'),
  /**
   * `Uncategorised` and `Rounding`. A system account cannot be deleted at all;
   * every account, system or not, refuses deletion while it holds lines.
   */
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_account_event_idx').on(table.eventId),
  // The target of the composite foreign key on a line: it is what lets the
  // database refuse a line on one event that posts to another event's account.
  uniqueIndex('events_account_event_id_unique').on(table.eventId, table.id),
  // One member account per person per event. Postgres treats NULLs as distinct,
  // so the two kinds that carry no email are simply not constrained by it.
  uniqueIndex('events_account_event_email_unique').on(table.eventId, table.email),
  // Category names are what the picker shows, so two accounts called "Food" on
  // one event is a bug the database can refuse rather than a mess to clean up.
  uniqueIndex('events_account_event_category_name_unique')
    .on(table.eventId, table.name)
    .where(sql`kind = 'category'`),
  // Exactly one rounding account per event: the residual has ONE home, or it is
  // not a home.
  uniqueIndex('events_account_event_rounding_unique')
    .on(table.eventId)
    .where(sql`kind = 'rounding'`)
])

/**
 * A JOURNAL ENTRY (#61). One paid cost on an event (trips mostly): who paid,
 * how much, and how it is split. Money is integer cents; there is no float
 * money anywhere near this table.
 *
 * The entry header carries what a person typed — the title, the total, the
 * currency, who fronted it. WHERE THE MONEY WENT is in the lines
 * (`events_expense_share`), which post to accounts and sum to zero. There is
 * no `category` column any more and no `kind` discriminator: an entry with a
 * line into a category account is a cost, and an entry whose lines touch only
 * member accounts is a transfer between two friends. The structure says which,
 * so nothing has to remember to set a flag.
 *
 * TWO AMOUNTS, ALWAYS (#25). `amount_cents`/`currency` is what was handed over;
 * `amount_base_cents`/`base_currency` is what it settles for, converted at
 * `fx_rate` when it was recorded and frozen there. Balances, settlements and
 * totals are computed from the base figures and from nothing else.
 *
 * This comment used to say `currency` was "informative — balances are only
 * computed within one currency". The first half was true and the second was
 * not: nothing enforced it, and `computeBalances` summed cents straight across
 * currencies. A schema comment claiming a constraint is not a constraint.
 *
 * NO DEFAULTS on the three conversion columns, on purpose. An insert that
 * forgets all three aborts; one that sets `amount_base_cents` and forgets the
 * other two would, with defaults, silently stamp CHF-at-1 on a EUR instance —
 * and then freeze the instance base there via the guard in
 * `server/domain/instance-settings.ts`.
 */
export const expense = pgTable('events_expense', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** The total AS SPENT, in the currency it was spent in. */
  amountCents: integer('amount_cents').notNull(),
  /** What was actually handed over — EUR for a dinner in Milan. */
  currency: text('currency').notNull().default('CHF'),
  /**
   * The instance base currency at the moment this was recorded, and the rate
   * that converted it (#25). Both are a SNAPSHOT: an expense entered in June
   * stays converted at June's rate forever, because a balance that moves when
   * the market does is not a balance anybody can settle.
   *
   * `fx_rate` is numeric, not a float — it is multiplied by money. It is 1
   * whenever `currency` is already the base, which is the ordinary case.
   */
  baseCurrency: text('base_currency').notNull(),
  fxRate: numeric('fx_rate', { precision: 20, scale: 10 }).notNull(),
  /**
   * The total in BASE cents — the only figure balances and settlements are ever
   * computed from. Materialised here rather than derived at read time so the
   * arithmetic is a plain sum and history cannot drift.
   */
  amountBaseCents: integer('amount_base_cents').notNull(),
  /**
   * How the total was divided (#26): evenly, by exact per-person amounts, by
   * percentage, or by weight ("Ana counts double").
   *
   * A RECORD OF INTENT, not an instruction. The shares are already materialised
   * below, so no read re-derives anything from this column; it exists so the
   * screen can say "split by weight" instead of showing four numbers with no
   * explanation, and so an edit can offer the mode back rather than starting
   * from `even` every time.
   *
   * WHAT IT DOES NOT RECOVER. `even` honours explicit per-person amounts and
   * splits the remainder across everybody else, and this column records nothing
   * about WHICH participants were pinned — the shares are cents either way. So
   * a mixed `even` expense is the one case an edit cannot re-split from the row
   * alone; `percentage`, `weight` (the entered numbers are on each share) and
   * `exact` (the amounts ARE the shares) all can. #27 is where that matters.
   *
   * No DEFAULT, for the same reason as the three conversion columns above:
   * `addExpense` always writes it, and an insert that forgets it should abort
   * rather than claim an even split nothing ever checked.
   */
  splitMode: text('split_mode', { enum: ['even', 'exact', 'percentage', 'weight'] }).notNull(),
  /** Who fronted the money — same name+email identity as RSVPs. */
  paidByName: text('paid_by_name').notNull(),
  paidByEmail: text('paid_by_email').notNull(),
  note: text('note'),
  /**
   * Who recorded it. Always an ACCOUNT since #48 — writing an expense needs a
   * session, so `created_by_user_id` is set on every new row and is what the
   * screen attributes ("paid by Ana · added by Matthew").
   *
   * `created_by_guest_email` is the email-only author of the old invite-link
   * write path and is NEVER WRITTEN AGAIN. It is still here because dropping a
   * column is a migration and this change deliberately carries none; the next
   * expense migration should take it with it.
   */
  createdByUserId: text('created_by_user_id'),
  createdByGuestEmail: text('created_by_guest_email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
}, table => [
  index('events_expense_event_idx').on(table.eventId),
  index('events_expense_paid_by_email_idx').on(table.paidByEmail)
])

/**
 * THE LINES OF ONE JOURNAL ENTRY (#61) — the table that used to hold only "one
 * participant's slice" and now holds every side of the transaction.
 *
 * Each line posts a SIGNED amount to an account: positive is a debit, negative
 * is a credit, and **the lines of an entry sum to zero** — in `amount_cents`
 * (what was handed over) and in `amount_base_cents` (what it settles for)
 * independently. That single invariant is what makes the rest of the budget a
 * sum rather than a special case; `assertEntryBalances` in
 * `server/domain/expenses.ts` refuses to write an entry that violates it.
 *
 * Ana pays 120 for dinner, split four ways, is seven lines:
 *
 *     credit  member:Ana        120     ← she fronted it
 *     debit   category:Food     120     ← THE COST
 *     credit  category:Food     120     ← pushed back out to the people
 *     debit   member:Ana         30
 *     debit   member:Ben         30
 *     debit   member:Cleo        30
 *     debit   member:Dee         30
 *
 * The category account ACCUMULATES: the trip total is the sum of debits into
 * category accounts, never the account's net (which is zero by design), so
 * "what did accommodation cost" is one query over one account. A transfer
 * between two friends posts member→member, touches no category account, and is
 * therefore structurally not a cost — which is why there is no `kind` flag.
 *
 * `account_id` IS NEVER NULL. Nullable-when-not-applicable is exactly where the
 * `currency` bug lived before #25 (stored, typed, rendered, read by nothing),
 * and the premise of this table is not inventing that class of bug again. The
 * name and the email a line used to repeat live on the member account instead.
 */
export const expenseShare = pgTable('events_expense_share', {
  id: text('id').primaryKey(),
  expenseId: text('expense_id').notNull().references(() => expense.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull().references(() => event.id, { onDelete: 'cascade' }),
  /**
   * Where this side of the transaction lands. Never null; never guessed, and
   * constrained to an account of THIS event by the composite foreign key below.
   */
  accountId: text('account_id').notNull(),
  /**
   * The line's position within its entry, from 0. The payer's credit, then the
   * category debit and credit, then one debit per person in the order the split
   * named them, then the rounding line if there is one.
   *
   * It exists because there is nothing else to order by. All the lines of an
   * entry are written in ONE insert, so they share `created_at` to the
   * microsecond (Postgres `now()` is transaction time), and cuid2 ids do not
   * sort by age — so `created_at, id` is a stable order but an arbitrary one,
   * and `shares[]` would come back in a different order than the person typed.
   */
  seq: integer('seq').notNull(),
  /** SIGNED, as spent: debit positive, credit negative. */
  amountCents: integer('amount_cents').notNull(),
  /**
   * SIGNED, in base cents — the figure every balance, total and settlement is
   * built from.
   *
   * Each member's debit is THEIR OWN share converted at the entry's frozen
   * rate, so what a person owes is explicable on its own ("your €40 at 0.9412
   * is CHF 37.65") rather than being the figure that made the column tidy. The
   * cents that rounding leaves over between the converted total and the sum of
   * the converted shares post to the event's `rounding` account, where they are
   * visible, instead of being absorbed by whoever happened to sort last.
   */
  amountBaseCents: integer('amount_base_cents').notNull(),
  /**
   * What this person had ENTERED for them under a `percentage` or `weight`
   * split — `33.33` or `2` — and null everywhere else (#26): under `even` and
   * `exact` the amounts are the whole of what was meant, and a category,
   * rounding or payer-credit line was never entered by anybody.
   *
   * Kept only so an edit of a `percentage` or `weight` expense can re-split
   * from the same numbers rather than asking for them again. `amount_cents`
   * stays the source of truth for every balance: nothing reads this column to
   * compute money, which is why a row whose weight says 2 and whose amount says
   * otherwise is a display problem and never a wrong settlement.
   */
  weight: numeric('weight', { precision: 12, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('events_expense_share_expense_idx').on(table.expenseId),
  index('events_expense_share_event_idx').on(table.eventId),
  index('events_expense_share_account_idx').on(table.accountId),
  // A line belongs to one event and posts to an account OF THAT EVENT. A plain
  // `account_id` reference lets a line on one trip post into another trip's
  // Food account — unreachable through today's write path, and exactly the
  // class of thing this issue exists not to re-invent, so the database refuses
  // it rather than the code remembering to.
  foreignKey({
    columns: [table.eventId, table.accountId],
    foreignColumns: [account.eventId, account.id],
    name: 'events_expense_share_event_account_fk'
  }).onDelete('restrict'),
  // At most one debit and one credit per account per entry. This is what the
  // old `(expense_id, email)` unique index bought — "Ana cannot appear twice" —
  // kept under a shape where Ana legitimately appears TWICE in one entry: once
  // credited for fronting the money and once debited for her own share. The
  // predicate is on the AS-SPENT amount, which is never zero on a credit (the
  // total is at least one cent), where the base amount can be zero on a tiny
  // expense at a small rate and would then collide with itself.
  uniqueIndex('events_expense_share_expense_account_debit_unique')
    .on(table.expenseId, table.accountId)
    .where(sql`amount_cents >= 0`),
  uniqueIndex('events_expense_share_expense_account_credit_unique')
    .on(table.expenseId, table.accountId)
    .where(sql`amount_cents < 0`)
])

/* ---------------------------- instance settings ---------------------------- */

/**
 * The instance's own settings — one row, id `instance` (#25, D6).
 *
 * There is exactly one zäme instance per deployment and its owner is the first
 * account registered, so a single row with TYPED COLUMNS is the honest shape: a
 * key/value table would store every setting as text, make each reader parse and
 * validate it, and give the database no way to hold a default. When a second
 * setting arrives it is a column here, which is a migration either way.
 *
 * The row is created on the first write. A missing row is not an error — it
 * means "still on the defaults", and every reader falls back to them.
 */
export const instanceSetting = pgTable('events_instance_setting', {
  id: text('id').primaryKey(),
  /**
   * The currency this instance settles up in — "expectation is to have the same
   * currency in the friends group" (D6). Every expense is converted into it at
   * write time and every balance is expressed in it.
   */
  baseCurrency: text('base_currency').notNull().default('CHF'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date())
})

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
  place,
  itineraryLeg,
  media,
  icalToken,
  dateOption,
  dateVote,
  contribution,
  seriesMember,
  account,
  expense,
  expenseShare,
  message,
  plannerInvite,
  instanceSetting
}
