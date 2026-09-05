import { eq, or } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { addPlanner } from './permissions'
import { generateUniqueSlug } from './slugify'
import { toDate } from './events-data'
import { normalisePosterUrl } from './poster'

/**
 * The concert announcement — zäme's half of the Music department's public
 * projection (ADR-0033 §4, ADR-0036 §concerts).
 *
 * Music keeps the concert as the record of truth (twelve years of history,
 * private by default); zäme holds only the announcement, and only while it is
 * published. Four calls that used to reach straight into `events_event` through
 * `@enterprise/events-core` collapse into the two functions below.
 *
 * IDEMPOTENCY IS BY `sourceId`, NOT BY the event id. The Enterprise concert id
 * is stored on `event.externalRef`, and a republish resolves against that. The
 * `eventId` Enterprise remembers is a HINT, consulted only when the external ref
 * does not resolve — which is exactly what makes `music_concert.public_event_id`
 * advisory: if it goes stale, the next publish still patches the right
 * announcement instead of minting a duplicate.
 */

export interface PublishConcertInput {
  /** The Enterprise `music_concert.id` — idempotency key and external ref. */
  sourceId: string
  /** The `publicEventId` Enterprise remembers. A hint; never authoritative. */
  eventId?: string | null
  title: string
  description?: string | null
  startsAt: string | Date
  endsAt?: string | Date | null
  location?: string | null
  ticketUrl?: string | null
  performerNote?: string | null
  /** A URL previously returned by `uploadPoster`, or null. */
  posterUrl?: string | null
}

export interface PublishConcertResult {
  ok: boolean
  eventId: string
  slug: string
  /** The public path on zäme, e.g. `/e/<slug>`. */
  url: string
  /** True when this call minted the announcement; false when it patched one. */
  created: boolean
}

/** Resolve an existing announcement: by external ref first, by the hint second. */
async function findAnnouncement(sourceId: string, eventIdHint?: string | null) {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.event)
    .where(eventIdHint
      ? or(eq(tables.event.externalRef, sourceId), eq(tables.event.id, eventIdHint))
      : eq(tables.event.externalRef, sourceId))
    .limit(2)

  // The external ref wins whenever both resolve — the hint may be stale.
  return rows.find(r => r.externalRef === sourceId) ?? rows[0] ?? null
}

/**
 * Create or patch the public event announcing a concert, and make the instance
 * owner its planner so it shows up on the host surface like anything else.
 */
export async function publishConcert(
  plannerUserId: string,
  input: PublishConcertInput
): Promise<PublishConcertResult> {
  const startsAt = toDate(input.startsAt)
  if (!startsAt) {
    throw createError({ statusCode: 422, message: 'A concert announcement needs a start time' })
  }

  const fields = {
    title: input.title,
    description: input.description ?? null,
    startsAt,
    endsAt: toDate(input.endsAt),
    location: input.location ?? null,
    ticketUrl: input.ticketUrl ?? null,
    performerNote: input.performerNote ?? null,
    // The row keeps the RELATIVE poster path; the gate and the OG card read it.
    posterUrl: normalisePosterUrl(input.posterUrl),
    isPublic: true,
    externalRef: input.sourceId
  }

  const db = useDb()
  const existing = await findAnnouncement(input.sourceId, input.eventId)

  if (existing) {
    const [updated] = await db
      .update(tables.event)
      .set({
        ...fields,
        // A republish restores the announcement: it is the Music side saying
        // "this is on", and an announcement taken down and put back up should
        // read as published again.
        status: existing.status === 'cancelled' ? 'cancelled' : 'published'
      })
      .where(eq(tables.event.id, existing.id))
      .returning()
    await addPlanner(updated!.id, plannerUserId, 'owner')
    return { ok: true, eventId: updated!.id, slug: updated!.slug, url: `/e/${updated!.slug}`, created: false }
  }

  const id = createId()
  const slug = await generateUniqueSlug(input.title)
  await db.transaction(async (tx) => {
    await tx.insert(tables.event).values({
      id,
      slug,
      type: 'concert',
      // Created already published: that is what puts it on `/concerts`. This
      // deliberately does NOT go through `setEventStatus` — there are no invites
      // to send, so there is no dispatch to fire.
      status: 'published',
      ...fields
    })
    await tx.insert(tables.eventPlanner).values({ id: createId(), eventId: id, userId: plannerUserId, role: 'owner' })
  })
  return { ok: true, eventId: id, slug, url: `/e/${slug}`, created: true }
}

export interface UnpublishConcertResult {
  ok: boolean
  eventId: string | null
  alreadyDown: boolean
}

/**
 * Take the announcement down: the event stops being public, so it leaves the
 * `/concerts` listing and its poster stops resolving (the poster gate asks the
 * events domain, per request, whether a public published event still points at
 * those bytes). The Music history is untouched. Idempotent.
 */
export async function unpublishConcert(sourceId: string): Promise<UnpublishConcertResult> {
  const existing = await findAnnouncement(sourceId)
  if (!existing) {
    throw createError({ statusCode: 404, message: 'No announcement was ever made for this concert' })
  }
  if (!existing.isPublic) {
    return { ok: true, eventId: existing.id, alreadyDown: true }
  }
  await useDb().update(tables.event).set({ isPublic: false }).where(eq(tables.event.id, existing.id))
  return { ok: true, eventId: existing.id, alreadyDown: false }
}
