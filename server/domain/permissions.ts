import { and, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { guestUser } from '../database/schema/auth'

/**
 * Event access control. Extracted from `layers/events/server/utils/
 * permissions.ts` (originally zaeme). The owner/co-planner/logistics model is
 * unchanged; `userId` is whichever auth domain the calling app resolved — the
 * Enterprise owner's better-auth id, or a zäme account's id (ADR-0019 §3/§4).
 */

export type PlannerRole = 'owner' | 'co_planner' | 'logistics'

/**
 * How an ACCOUNT belongs to an event: as one of its planners, or as somebody
 * who was invited and answered. See `assertParticipant`.
 */
export type ParticipantRole = PlannerRole | 'participant'

interface AssertPlannerOpts {
  /** If provided, only these roles pass the check. Default: any role. */
  roles?: readonly PlannerRole[]
}

/**
 * An event that is not open to the people invited to it. `draft` has not been
 * shown to anybody yet and `cancelled` is over; neither may take a guest-side
 * write.
 *
 * This lived INSIDE `resolveInviteToken` (`server/domain/invite.ts`) and was
 * reachable only by going through a token — so moving expense writes off the
 * capability URL silently dropped it, and an expense could be recorded against
 * a cancelled trip (#48 review). It is a rule about the EVENT, not about the
 * link, so it lives here now and both paths call it.
 *
 * `completed` deliberately still passes: settling up happens after the trip.
 *
 * The parameter is the SCHEMA's status union, not `{ status: string }`. Widened
 * to `string` this compiles against any row that happens to have a `status` —
 * an RSVP, an invite — and, worse, renaming a value in
 * `text('status', { enum: [...] })` would leave the comparisons below matching
 * nothing with `pnpm typecheck` still green. That is the `events_expense.currency`
 * shape exactly: a guard nobody notices has stopped guarding.
 */
export function assertEventOpenToGuests(ev: Pick<typeof tables.event.$inferSelect, 'status'>): void {
  if (ev.status === 'draft' || ev.status === 'cancelled') {
    throw createError({ statusCode: 403, message: 'Event is not currently accepting RSVPs' })
  }
}

/**
 * A place id may only be used by the event that owns it (#30).
 *
 * Two modules need this rule and neither may import the other:
 * `events-data.ts` attaches a place to a timeline item, and `places.ts`
 * attaches two of them to a leg. A leg's endpoints are additionally held by a
 * composite foreign key `(event_id, place_id)`, which the database enforces
 * whatever the code does; `events_timeline_item.place_id` cannot have one,
 * because `on delete set null` on a composite key would null `event_id` with
 * it. So on that path this function IS the constraint, and it answers 422
 * rather than letting a plausible-looking id from another trip land silently.
 *
 * Returns the place, so a caller that needs the row does not read it twice.
 */
export async function assertPlaceOnEvent(eventId: string, placeId: string) {
  const [row] = await useDb()
    .select()
    .from(tables.place)
    .where(and(eq(tables.place.id, placeId), eq(tables.place.eventId, eventId)))
    .limit(1)
  if (!row) {
    throw createError({ statusCode: 422, message: 'That place is not on this event' })
  }
  return row
}

export async function loadEventBySlug(slug: string) {
  const [row] = await useDb().select().from(tables.event).where(eq(tables.event.slug, slug)).limit(1)
  if (!row) {
    throw createError({ statusCode: 404, message: 'Event not found' })
  }
  return row
}

export async function assertPlanner(
  eventId: string,
  userId: string,
  opts: AssertPlannerOpts = {}
): Promise<PlannerRole> {
  const [row] = await useDb()
    .select({ role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
    .limit(1)

  if (!row) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  const role = row.role as PlannerRole
  if (opts.roles && !opts.roles.includes(role)) {
    throw createError({ statusCode: 403, message: 'Forbidden' })
  }
  return role
}

/**
 * Add a planner to an event, idempotently (no-op if the user already has a
 * planner row). Used by zäme's create flow to attach the instance owner as a
 * co-planner alongside the zäme host (ADR-0019 §4: the owner sees everything).
 */
export async function addPlanner(eventId: string, userId: string, role: PlannerRole = 'co_planner'): Promise<void> {
  const db = useDb()
  const [existing] = await db
    .select({ id: tables.eventPlanner.id })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
    .limit(1)
  if (existing) return
  await db.insert(tables.eventPlanner).values({ id: createId(), eventId, userId, role })
}

/**
 * The account-scoped counterpart of `assertPlanner`: is this signed-in account
 * ON this event at all? A planner row passes, and so does an RSVP whose
 * `guestEmail` is the account's email — because in zäme a person IS their
 * lowercased email address (`server/domain/guest.ts`), and an account is the
 * same person having proved they hold that address. There is deliberately no
 * second identity model; matching the email is the whole of it.
 *
 * This exists because expense WRITES moved off the invite capability URL and
 * onto an account (#48): the link no longer buys the right to record money, but
 * a trip participant is not a planner either, so neither existing gate fits.
 * Reads over the invite link are untouched.
 *
 * It answers the STRONGEST standing, and `logistics` is the weakest — it is the
 * one planner role that does not by itself say the holder is on the trip, and
 * the one the host surface already refuses an expense write. So a logistics
 * planner who ALSO RSVP'd comes back `participant` rather than being turned away
 * by their own planner row; only a logistics planner with no RSVP comes back
 * `logistics`, and the caller decides what that is worth.
 */
export async function assertParticipant(eventId: string, userId: string): Promise<ParticipantRole> {
  const db = useDb()

  const [planner] = await db
    .select({ role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .where(and(eq(tables.eventPlanner.eventId, eventId), eq(tables.eventPlanner.userId, userId)))
    .limit(1)

  const plannerRole = planner ? planner.role as PlannerRole : null
  if (plannerRole === 'owner' || plannerRole === 'co_planner') return plannerRole

  const [account] = await db
    .select({ email: guestUser.email })
    .from(guestUser)
    .where(eq(guestUser.id, userId))
    .limit(1)

  if (account) {
    // RSVP emails are stored lowercased on write; lowercase this side too
    // rather than trusting the stored casing.
    const [rsvp] = await db
      .select({ id: tables.rsvp.id })
      .from(tables.rsvp)
      .where(and(eq(tables.rsvp.eventId, eventId), eq(tables.rsvp.guestEmail, account.email.toLowerCase())))
      .limit(1)
    if (rsvp) return 'participant'
  }

  if (plannerRole) return plannerRole

  throw createError({ statusCode: 403, message: 'You are not on this event — RSVP first, then you can add expenses' })
}

/**
 * Does this account hold a PLANNER row on the event named by `slug` — and which
 * one? The audit recorder's question (#51), and deliberately not
 * `assertParticipant`'s.
 *
 * `/api/me` is the ACCOUNT surface: the caller may be a planner of the event in
 * the path, or a friend who merely RSVP'd, and until this existed the audit
 * called both of them planners. The distinction the log needs is exactly the
 * one word above — planner or not — so this asks it in ONE indexed statement,
 * joined on the slug rather than loading the event first, instead of paying
 * `assertParticipant`'s four lookups for an answer it would then throw away.
 *
 * It never throws and it never 403s. A missing event, an unknown slug and an
 * account with no standing all answer `null`: this decides a LABEL, not access,
 * and refusing the request is the handler's job a few milliseconds later.
 */
export async function findPlannerRoleBySlug(slug: string, userId: string): Promise<PlannerRole | null> {
  const [row] = await useDb()
    .select({ role: tables.eventPlanner.role })
    .from(tables.eventPlanner)
    .innerJoin(tables.event, eq(tables.event.id, tables.eventPlanner.eventId))
    .where(and(eq(tables.event.slug, slug), eq(tables.eventPlanner.userId, userId)))
    .limit(1)
  return row ? row.role as PlannerRole : null
}
