import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { toDate } from './events-data'
import { assertPlaceOnEvent, assertPlanner, loadEventBySlug } from './permissions'

/**
 * THE GEOGRAPHY OF AN EVENT (#30): the places an itinerary happens at, and the
 * legs between them.
 *
 * Before this, an itinerary was a sorted list of strings — one free-text
 * `location` per item, no pin, no coordinate, and no way to say that the 09:14
 * connects two of them. Two tables fix that, and the shape of both is decided
 * by what they have to survive rather than by what is tidy:
 *
 *  - A PLACE MAY HAVE NO COORDINATES. "Ana's flat" is a place; it will never be
 *    geocoded and must not be a half-filled row waiting for somebody to finish
 *    it. `lat`/`lng` are therefore nullable, together and never singly, and
 *    they can be filled in later — which is what the geocoding search (#32)
 *    will do to the ones worth looking up.
 *  - A LEG IS WRITTEN BY GUESTS TOO. "We ended up walking" happens while the
 *    host is asleep, so `addLegForEvent` at the bottom of this file is reached
 *    from the invite capability URL (through `guestAddLeg` in
 *    `server/domain/guest.ts`, which resolves the token) — and
 *    `resolveInviteToken` is what carries the revocation, the expiry, the use
 *    limit and the `draft`/`cancelled` lifecycle refusal that #48 learned the
 *    cost of losing.
 *
 * NOT ON `/api/v1`, on purpose. Enterprise has no use for a trip's places, and
 * a route there becomes an MCP tool the owner never asked for (#8's precedent,
 * restated in #30). Host and guest surfaces only; `docs/zaeme-api.openapi.yaml`
 * does not move.
 */

/* ------------------------------ coordinates ------------------------------- */

/**
 * `numeric(9, 6)` is what this lands in, so at most three digits before the
 * point. A shape check BEFORE the round below, so a 300-digit string or a
 * `1e40` never reaches Postgres to be rejected there as a 500.
 *
 * The twenty decimals it allows are not the column's — they are the CALLER's:
 * `String(47.37688659999999)` is what a browser hands over after doing its own
 * arithmetic, and Nominatim answers seven. Everything past the sixth is rounded
 * off below; refusing it instead would refuse #32's own payload.
 */
const COORDINATE_PATTERN = /^-?\d{1,3}(?:\.\d{1,20})?$/

/** Six decimal places is ~11 cm at the equator, and the column's scale. */
const COORDINATE_DP = 6

/**
 * A typed or geocoded coordinate as the number this stores — rounded to six
 * decimal places HERE rather than left to Postgres.
 *
 * Nominatim answers seven decimals and a browser's own arithmetic can produce
 * seventeen, so refusing anything longer would refuse #32's own payload. The
 * rounding is explicit because the alternative is `numeric` doing it silently
 * on insert: same stored value, but nothing in the code would say that the
 * value it handed on is not the value it was given, and the next person to read
 * a coordinate back would find a digit missing with no explanation. 11 cm is
 * far below what a trip planner can mean by "here".
 *
 * A value sitting EXACTLY on the half (…5 in the seventh decimal) is rounded by
 * `toFixed`, which decides it from the binary representation rather than from
 * the digits — so it can go either way. That is one ten-millionth of a degree
 * and there is nothing on a map at that scale to be wrong about; making it
 * deterministic would mean doing decimal arithmetic on the string, which is
 * work for no reader.
 */
function normaliseCoordinate(value: number | string, max: number, field: string): number {
  const raw = `${value}`.trim()
  if (!COORDINATE_PATTERN.test(raw)) {
    throw createError({ statusCode: 422, message: `${field} must be a decimal number of degrees, e.g. 46.004512` })
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < -max || n > max) {
    throw createError({ statusCode: 422, message: `${field} must be between -${max} and ${max}` })
  }
  return Number(n.toFixed(COORDINATE_DP))
}

/**
 * The pair, or nothing at all. HALF A COORDINATE IS NOT A LOCATION: a place
 * carrying a latitude and no longitude sorts into a bounding box, draws on a
 * map at the wrong spot, and clusters with whatever else shares its meridian —
 * so it is refused rather than stored and worked around by every future reader.
 * `null` for both is the ordinary case and the one this table exists to keep.
 *
 * Exported because it is the one piece of this module that is pure, and a rule
 * this small should not need a booted server and a live Postgres to be shown
 * wrong (`test/places-and-legs.test.ts`). #32's geocoder will want it too: what
 * a search result offers has to land in the same column by the same rule.
 *
 * Returns the STRINGS that go into `numeric(9, 6)` — drizzle's type for that
 * column — so `8.95105` is what is written and `'8.951050'` is what Postgres
 * pads it back to on read. `placeView` turns that into the number every caller
 * actually wants.
 */
export function normaliseCoordinates(
  lat: number | string | null | undefined,
  lng: number | string | null | undefined
): { lat: string | null, lng: string | null } {
  const hasLat = lat !== null && lat !== undefined && `${lat}`.trim() !== ''
  const hasLng = lng !== null && lng !== undefined && `${lng}`.trim() !== ''
  if (!hasLat && !hasLng) return { lat: null, lng: null }
  if (!hasLat || !hasLng) {
    throw createError({ statusCode: 422, message: 'A place needs both a latitude and a longitude, or neither' })
  }
  return {
    lat: `${normaliseCoordinate(lat!, 90, 'Latitude')}`,
    lng: `${normaliseCoordinate(lng!, 180, 'Longitude')}`
  }
}

/* --------------------------------- views ---------------------------------- */

export type OsmType = 'node' | 'way' | 'relation'
export type TravelMode = 'walk' | 'bike' | 'car' | 'train' | 'bus' | 'ferry' | 'plane' | 'other'

/**
 * A place as every screen reads it.
 *
 * `lat`/`lng` come back as NUMBERS while the column is `numeric`, which is a
 * deliberate seam and not an oversight. The column is exact decimal because
 * that is what a stored coordinate should be — what was typed is what comes
 * back, and it sorts and indexes for "the places inside this box". The VIEW is
 * a number because every consumer of it does arithmetic: a map takes
 * `[lat, lng]`, a distance is trigonometry, and #33's clustering is both. A
 * driver string (`'46.004512'`, padded to the column's scale) would make every
 * one of those callers remember to parse it, and the one that forgot would
 * concatenate instead of adding.
 */
export interface PlaceView {
  id: string
  name: string
  address: string | null
  lat: number | null
  lng: number | null
  osmType: OsmType | null
  osmId: string | null
  note: string | null
  createdAt: Date
}

/** A leg, with its endpoints named so a list needs no second lookup. */
export interface LegView {
  id: string
  fromPlaceId: string | null
  toPlaceId: string | null
  fromPlaceName: string | null
  toPlaceName: string | null
  mode: TravelMode
  departsAt: Date | null
  arrivesAt: Date | null
  durationMinutes: number | null
  note: string | null
  sortOrder: number
  isPlanned: boolean
  createdAt: Date
}

export interface Geography {
  places: PlaceView[]
  legs: LegView[]
}

function placeView(row: typeof tables.place.$inferSelect): PlaceView {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    // `numeric` arrives as a string PADDED TO ITS SCALE — '46.004512', and
    // '47' as '47.000000'. Number() is what turns both into the coordinate.
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    osmType: row.osmType,
    osmId: row.osmId,
    note: row.note,
    createdAt: row.createdAt
  }
}

function legView(row: typeof tables.itineraryLeg.$inferSelect, names: Map<string, string>): LegView {
  return {
    id: row.id,
    fromPlaceId: row.fromPlaceId,
    toPlaceId: row.toPlaceId,
    fromPlaceName: row.fromPlaceId ? names.get(row.fromPlaceId) ?? null : null,
    toPlaceName: row.toPlaceId ? names.get(row.toPlaceId) ?? null : null,
    mode: row.mode,
    departsAt: row.departsAt,
    arrivesAt: row.arrivesAt,
    durationMinutes: row.durationMinutes,
    note: row.note,
    sortOrder: row.sortOrder,
    isPlanned: row.isPlanned,
    createdAt: row.createdAt
  }
}

/* --------------------------------- reads ---------------------------------- */

/**
 * The places and the legs of one event, in display order.
 *
 * THE LEGS ARE READ FIRST AND THE PLACES SECOND, which is not the order they
 * are returned in. A leg names two places, so the lookup side has to be read
 * LAST for the map to be a superset of what the legs reference: read the other
 * way round, a place created between the two statements leaves a leg whose
 * endpoint is not in the map and whose name renders as nothing. `loadBudget`
 * had exactly this bug with accounts and lines (#61).
 *
 * The leg order is `sort_order`, then `departs_at` (nulls last), then
 * `created_at`, then `id` — the same four keys `applyItineraryLegMove`
 * renumbers from and that `app/utils/itinerary-order.ts` breaks ties on. All
 * three must stay in step or the arrows move the wrong row.
 */
export async function loadGeography(eventId: string): Promise<Geography> {
  const db = useDb()

  const legs = await db
    .select()
    .from(tables.itineraryLeg)
    .where(eq(tables.itineraryLeg.eventId, eventId))
    .orderBy(
      asc(tables.itineraryLeg.sortOrder),
      asc(tables.itineraryLeg.departsAt),
      asc(tables.itineraryLeg.createdAt),
      asc(tables.itineraryLeg.id)
    )

  const places = await db
    .select()
    .from(tables.place)
    .where(eq(tables.place.eventId, eventId))
    .orderBy(asc(tables.place.createdAt), asc(tables.place.id))

  const names = new Map(places.map(p => [p.id, p.name]))
  return { places: places.map(placeView), legs: legs.map(l => legView(l, names)) }
}

/** The geography of an event this account plans. */
export async function loadGeographyAsPlanner(userId: string, slug: string): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return loadGeography(ev.id)
}

/* -------------------------------- places ---------------------------------- */

export interface CreatePlaceInput {
  name: string
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
  osmType?: OsmType | null
  osmId?: string | null
  note?: string | null
}

/**
 * Add a place (owner/co-planner only).
 *
 * Deliberately NOT on the guest surface. A guest holding the link may record
 * that they walked between two places the group already has; minting new points
 * on the trip's map is the planners', and widening that is the owner's call
 * rather than a side effect of this issue.
 */
export async function addPlaceAsPlanner(userId: string, slug: string, input: CreatePlaceInput): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  const { lat, lng } = normaliseCoordinates(input.lat, input.lng)

  await useDb().insert(tables.place).values({
    id: createId(),
    eventId: ev.id,
    name: input.name.trim(),
    address: input.address ?? null,
    lat,
    lng,
    osmType: input.osmType ?? null,
    osmId: input.osmId ?? null,
    note: input.note ?? null,
    createdByUserId: userId
  })

  return loadGeography(ev.id)
}

export interface UpdatePlaceInput {
  name?: string
  address?: string | null
  lat?: number | string | null
  lng?: number | string | null
  osmType?: OsmType | null
  osmId?: string | null
  note?: string | null
}

/**
 * Correct a place, or give one its coordinates (owner/co-planner only).
 *
 * COORDINATES MOVE AS A PAIR HERE TOO, and that is why `lat` and `lng` are read
 * together rather than one at a time: a PATCH carrying only a latitude would
 * otherwise leave the row half-coordinated, which is the state `addPlace`
 * refuses. Sending one of the two is an error; sending both as null clears them
 * and returns the place to "somewhere we know the name of".
 */
export async function updatePlaceAsPlanner(
  userId: string,
  slug: string,
  placeId: string,
  input: UpdatePlaceInput
): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await assertPlaceOnEvent(ev.id, placeId)

  const updates: Record<string, unknown> = {}
  if (input.name !== undefined) updates.name = input.name.trim()
  if (input.address !== undefined) updates.address = input.address
  if (input.note !== undefined) updates.note = input.note
  if (input.osmType !== undefined) updates.osmType = input.osmType
  if (input.osmId !== undefined) updates.osmId = input.osmId
  if (input.lat !== undefined || input.lng !== undefined) {
    const { lat, lng } = normaliseCoordinates(input.lat, input.lng)
    updates.lat = lat
    updates.lng = lng
  }

  if (Object.keys(updates).length > 0) {
    await useDb()
      .update(tables.place)
      .set(updates)
      .where(and(eq(tables.place.id, placeId), eq(tables.place.eventId, ev.id)))
  }
  return loadGeography(ev.id)
}

/** What removing a place did to everything that pointed at it. */
export interface PlaceRemoval extends Geography {
  /** Legs whose OTHER end survived: they keep their note, mode and times. */
  detachedLegs: number
  /** Legs left joining nowhere to nowhere — removed with the place. */
  removedLegs: number
  /** Itinerary items that were pinned here and fall back to their own text. */
  detachedItems: number
}

/**
 * Remove a place (owner/co-planner only), and say what that did.
 *
 * THE DEFINED BEHAVIOUR #30 ASKS FOR, and it is three different answers
 * because there are three different situations:
 *
 *  - a leg with its OTHER end still on the map keeps everything a person wrote
 *    — the mode, the times, the note — and loses one endpoint. "We walked from
 *    somewhere to the station" is a worse record than before and a much better
 *    one than nothing;
 *  - a leg whose other end is ALREADY gone is removed with this one. That is
 *    the second delete, and what it would otherwise leave behind is a journey
 *    from nowhere to nowhere, which is not a record but litter. (A leg cannot
 *    start and end at the same place — `insertLeg` refuses that — so this is
 *    the only way both ends can be lost.)
 *  - a timeline item pinned here keeps its free-text `location` and stops
 *    pointing at a pin (`on delete set null` on the column).
 *
 * All of it in ONE transaction, and in this order: the legs that are about to
 * lose their last endpoint go FIRST, because the two updates below would
 * otherwise null it and leave exactly the ghost this refuses to keep.
 *
 * The composite foreign keys are `restrict`, so a place still referenced by a
 * leg cannot be deleted by accident from anywhere else — the database refuses
 * it rather than this function being the only thing that remembers.
 */
export async function deletePlaceAsPlanner(userId: string, slug: string, placeId: string): Promise<PlaceRemoval> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await assertPlaceOnEvent(ev.id, placeId)

  const db = useDb()
  const counts = await db.transaction(async (tx) => {
    const removed = await tx
      .delete(tables.itineraryLeg)
      .where(and(
        eq(tables.itineraryLeg.eventId, ev.id),
        or(
          and(eq(tables.itineraryLeg.fromPlaceId, placeId), isNull(tables.itineraryLeg.toPlaceId)),
          and(eq(tables.itineraryLeg.toPlaceId, placeId), isNull(tables.itineraryLeg.fromPlaceId))
        )
      ))
      .returning({ id: tables.itineraryLeg.id })

    const detachedFrom = await tx
      .update(tables.itineraryLeg)
      .set({ fromPlaceId: null })
      .where(and(eq(tables.itineraryLeg.eventId, ev.id), eq(tables.itineraryLeg.fromPlaceId, placeId)))
      .returning({ id: tables.itineraryLeg.id })

    const detachedTo = await tx
      .update(tables.itineraryLeg)
      .set({ toPlaceId: null })
      .where(and(eq(tables.itineraryLeg.eventId, ev.id), eq(tables.itineraryLeg.toPlaceId, placeId)))
      .returning({ id: tables.itineraryLeg.id })

    const items = await tx
      .select({ id: tables.timelineItem.id })
      .from(tables.timelineItem)
      .where(and(eq(tables.timelineItem.eventId, ev.id), eq(tables.timelineItem.placeId, placeId)))

    await tx.delete(tables.place).where(and(eq(tables.place.id, placeId), eq(tables.place.eventId, ev.id)))

    return {
      removedLegs: removed.length,
      // A leg is counted once: the ones that lost their last endpoint are
      // already gone by the time the two updates above run.
      detachedLegs: detachedFrom.length + detachedTo.length,
      detachedItems: items.length
    }
  })

  return { ...counts, ...(await loadGeography(ev.id)) }
}

/* --------------------------------- legs ----------------------------------- */

export interface CreateLegInput {
  fromPlaceId: string
  toPlaceId: string
  mode: TravelMode
  departsAt?: string | Date | null
  arrivesAt?: string | Date | null
  durationMinutes?: number | null
  note?: string | null
  /** The 09:14 we mean to take, or the bus we got on. The surfaces differ. */
  isPlanned: boolean
}

/**
 * Write a leg, once the caller has settled WHO is allowed to (a planner row on
 * the host surface, an unrevoked invite token on the guest one).
 *
 * BOTH ENDPOINTS ARE REQUIRED even though the columns are nullable: null is
 * where a deleted place leaves a hole, not something anybody may write. Both
 * are checked against THIS event — the composite foreign keys would refuse a
 * foreign one anyway, but as a 500 from the driver rather than as a sentence.
 *
 * A leg from a place to itself is refused: it is a typo every time, and the
 * one thing it could mean ("we wandered around the old town") is a timeline
 * item, which the itinerary has had all along.
 */
async function insertLeg(eventId: string, input: CreateLegInput) {
  if (input.fromPlaceId === input.toPlaceId) {
    throw createError({ statusCode: 422, message: 'A leg goes between two different places' })
  }
  await assertPlaceOnEvent(eventId, input.fromPlaceId)
  await assertPlaceOnEvent(eventId, input.toPlaceId)

  const departsAt = toDate(input.departsAt)
  const arrivesAt = toDate(input.arrivesAt)
  if (departsAt && arrivesAt && arrivesAt.getTime() < departsAt.getTime()) {
    throw createError({ statusCode: 422, message: 'A leg cannot arrive before it departs' })
  }
  if (input.durationMinutes !== null && input.durationMinutes !== undefined && input.durationMinutes < 0) {
    throw createError({ statusCode: 422, message: 'A leg cannot take less than no time' })
  }

  // Appended after the existing legs, ten apart — the same numbering
  // `addTimelineItem` uses, so a move has room to renumber without churn.
  const existing = await useDb()
    .select({ sortOrder: tables.itineraryLeg.sortOrder })
    .from(tables.itineraryLeg)
    .where(eq(tables.itineraryLeg.eventId, eventId))
    .orderBy(asc(tables.itineraryLeg.sortOrder), asc(tables.itineraryLeg.id))
  const last = existing[existing.length - 1]

  const [inserted] = await useDb()
    .insert(tables.itineraryLeg)
    .values({
      id: createId(),
      eventId,
      fromPlaceId: input.fromPlaceId,
      toPlaceId: input.toPlaceId,
      mode: input.mode,
      departsAt,
      arrivesAt,
      durationMinutes: input.durationMinutes ?? null,
      note: input.note ?? null,
      sortOrder: last ? last.sortOrder + 10 : 0,
      isPlanned: input.isPlanned
    })
    .returning()
  return inserted!
}

/** Add a leg from the host surface (owner/co-planner only). */
export async function addLegAsPlanner(userId: string, slug: string, input: CreateLegInput): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await insertLeg(ev.id, input)
  return loadGeography(ev.id)
}

export interface UpdateLegInput {
  mode?: TravelMode
  departsAt?: string | Date | null
  arrivesAt?: string | Date | null
  durationMinutes?: number | null
  note?: string | null
  isPlanned?: boolean
  fromPlaceId?: string
  toPlaceId?: string
}

/** Correct a leg (owner/co-planner only). */
export async function updateLegAsPlanner(
  userId: string,
  slug: string,
  legId: string,
  input: UpdateLegInput
): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [existing] = await useDb()
    .select()
    .from(tables.itineraryLeg)
    .where(and(eq(tables.itineraryLeg.id, legId), eq(tables.itineraryLeg.eventId, ev.id)))
    .limit(1)
  if (!existing) throw createError({ statusCode: 404, message: 'Leg not found' })

  const updates: Record<string, unknown> = {}
  if (input.mode !== undefined) updates.mode = input.mode
  if (input.note !== undefined) updates.note = input.note
  if (input.isPlanned !== undefined) updates.isPlanned = input.isPlanned
  if (input.durationMinutes !== undefined) {
    if (input.durationMinutes !== null && input.durationMinutes < 0) {
      throw createError({ statusCode: 422, message: 'A leg cannot take less than no time' })
    }
    updates.durationMinutes = input.durationMinutes
  }
  if (input.fromPlaceId !== undefined) {
    await assertPlaceOnEvent(ev.id, input.fromPlaceId)
    updates.fromPlaceId = input.fromPlaceId
  }
  if (input.toPlaceId !== undefined) {
    await assertPlaceOnEvent(ev.id, input.toPlaceId)
    updates.toPlaceId = input.toPlaceId
  }
  if ((updates.fromPlaceId ?? existing.fromPlaceId) !== null
    && (updates.fromPlaceId ?? existing.fromPlaceId) === (updates.toPlaceId ?? existing.toPlaceId)) {
    throw createError({ statusCode: 422, message: 'A leg goes between two different places' })
  }

  // The two times are checked against EACH OTHER, so whichever of them the
  // patch carries is compared with the one already on the row — a PATCH that
  // moves only the arrival can still put it before the departure.
  if (input.departsAt !== undefined) updates.departsAt = toDate(input.departsAt)
  if (input.arrivesAt !== undefined) updates.arrivesAt = toDate(input.arrivesAt)
  const departsAt = (updates.departsAt ?? existing.departsAt) as Date | null
  const arrivesAt = (updates.arrivesAt ?? existing.arrivesAt) as Date | null
  if (departsAt && arrivesAt && arrivesAt.getTime() < departsAt.getTime()) {
    throw createError({ statusCode: 422, message: 'A leg cannot arrive before it departs' })
  }

  if (Object.keys(updates).length > 0) {
    await useDb()
      .update(tables.itineraryLeg)
      .set(updates)
      .where(and(eq(tables.itineraryLeg.id, legId), eq(tables.itineraryLeg.eventId, ev.id)))
  }
  return loadGeography(ev.id)
}

/** Remove a leg (owner/co-planner only). */
export async function deleteLegAsPlanner(userId: string, slug: string, legId: string): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  const removed = await useDb()
    .delete(tables.itineraryLeg)
    .where(and(eq(tables.itineraryLeg.id, legId), eq(tables.itineraryLeg.eventId, ev.id)))
    .returning({ id: tables.itineraryLeg.id })
  if (!removed.length) throw createError({ statusCode: 404, message: 'Leg not found' })
  return loadGeography(ev.id)
}

export type LegMove = 'up' | 'down'

/** Move a leg one place in the order (owner/co-planner only). */
export async function moveLegAsPlanner(
  userId: string,
  slug: string,
  legId: string,
  direction: LegMove
): Promise<Geography> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await applyItineraryLegMove({ eventId: ev.id, legId, direction })
  return loadGeography(ev.id)
}

export interface ApplyItineraryLegMove {
  eventId: string
  legId: string
  direction: LegMove
}

/**
 * Re-order the legs in ONE statement — `applyTimelineItemMove`'s mechanism
 * (`server/domain/events-data.ts`), applied to this table.
 *
 * It is a second copy rather than a shared helper on purpose, and the reason is
 * worth stating so the next person can overrule it deliberately: the statement
 * is a `sql` template whose table name and whose ORDERING COLUMNS both differ
 * (`departs_at` here, `starts_at` there), so sharing it means interpolating
 * identifiers — and drizzle renders an interpolated column UNQUALIFIED inside a
 * `sql` template, which Postgres then resolves against whatever table is in
 * scope without erroring. That is the bug the note at the top of `admin.ts`
 * documents at length. Refactoring #8's proven statement to carry a parameter
 * is also not this issue's to do.
 *
 * Everything the original's comment says applies here unchanged, and these are
 * the parts that are load-bearing rather than decorative:
 *
 *  - ONE statement, so it cannot half-apply and can never CREATE a tie, and it
 *    renumbers unconditionally, so it REMOVES any tie already there;
 *  - a move off either end is a no-op rather than an error, and still
 *    normalises the numbering;
 *  - the `select … for update` is what stops two planners reordering at once
 *    from producing the tie this exists to remove — `is distinct from` skips
 *    unchanged rows and in doing so drops them from the lock set. Ordering that
 *    lock by `id` also stops the two of them deadlocking.
 *
 * The display order below must agree with the order the ARROWS were drawn from,
 * down to the last tiebreak: `loadGeography` and `app/utils/itinerary-order.ts`
 * end on the same `…, created_at, id` for that reason.
 */
export async function applyItineraryLegMove({ eventId, legId, direction }: ApplyItineraryLegMove): Promise<void> {
  const delta = direction === 'up' ? -1 : 1

  await useDb().transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select id from events_itinerary_leg where event_id = ${eventId} order by id for update
    `)
    const ids = new Set((locked.rows as Array<{ id: string }>).map(r => r.id))
    if (!ids.has(legId)) throw createError({ statusCode: 404, message: 'Leg not found' })

    await tx.execute(sql`
      with ordered as (
        select id,
               (row_number() over (order by sort_order, departs_at nulls last, created_at, id) - 1)::int as idx
          from events_itinerary_leg
         where event_id = ${eventId}
      ),
      moved as (select idx from ordered where id = ${legId}),
      target as (
        select case
                 when (select idx from moved) + ${delta} between 0 and (select max(idx) from ordered)
                   then (select idx from moved) + ${delta}
               end as idx
      ),
      renumbered as (
        select o.id,
               case
                 when (select idx from target) is null then o.idx
                 when o.id = ${legId} then (select idx from target)
                 when o.idx = (select idx from target) then (select idx from moved)
                 else o.idx
               end as idx
          from ordered o
      )
      update events_itinerary_leg t
         set sort_order = renumbered.idx * 10,
             updated_at = now()
        from renumbered
       where t.id = renumbered.id
         and t.event_id = ${eventId}
         and t.sort_order is distinct from renumbered.idx * 10
    `)
  })
}

/* ---------------------------- the guest surface ---------------------------- */

/**
 * What a guest may say about a leg. No `isPlanned`: the guest surface exists
 * for what HAPPENED, and letting the link declare a plan would put the
 * itinerary's intent in the hands of whoever it was forwarded to.
 */
export interface GuestLegInput {
  fromPlaceId: string
  toPlaceId: string
  mode: TravelMode
  departsAt?: string | null
  arrivesAt?: string | null
  durationMinutes?: number | null
  note?: string | null
}

/**
 * "We ended up walking" — a leg recorded by whoever holds the invite link.
 *
 * The event id comes from the TOKEN and from nowhere else, so a guest can only
 * ever write to the event their link is for; the two endpoints are then checked
 * against that event, which makes a place id from another trip a 422 rather
 * than a leg pointing across a boundary. `isPlanned` is false and is not an
 * input: see `GuestLegInput`.
 *
 * The caller resolves the token (`resolveInviteToken` in `server/domain/
 * guest.ts`), which is what applies revocation, expiry, the use-count limit and
 * the `draft`/`cancelled` refusal. Nothing in this module may read a session.
 */
export async function addLegForEvent(eventId: string, input: GuestLegInput): Promise<Geography> {
  await insertLeg(eventId, { ...input, isPlanned: false })
  return loadGeography(eventId)
}
