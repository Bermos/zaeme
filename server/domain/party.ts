import { eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import { createEvent, type EventDispatch } from './events-data'
import { addDateOption } from './poll'

/**
 * The party flow (two-stage planning): a small CORE group fixes the date via
 * the poll, then the host "opens up" — locking the date publishes the event,
 * and the general wave (a shareable link and/or more personal invites) brings
 * in everyone who has time. Sign-up (RSVP) is required either way — the party
 * needs a headcount. This module is the convenience wrapper that sets the
 * whole first stage up in one call; the pieces underneath are the ordinary
 * poll/invite operations.
 */

export interface CreatePartyInput {
  title: string
  description?: string | null
  posterUrl?: string | null
  location?: string | null
  /** The core group who pick the date — one personalised `core` invite each. */
  coreInvites: Array<{ name: string, email?: string | null }>
  /** Candidate dates the core group votes on. */
  dateOptions: Array<{ startsAt: string | Date, endsAt?: string | Date | null, note?: string | null }>
}

/**
 * Stage 1 in one call: create the party, seed the date options, invite the
 * core group, and open the poll. Returns the created invites so the host can
 * hand each friend their link immediately.
 */
export async function createParty(userId: string, input: CreatePartyInput) {
  if (input.coreInvites.length === 0) {
    throw createError({ statusCode: 422, message: 'A party needs a core group to fix the date with' })
  }
  if (input.dateOptions.length === 0) {
    throw createError({ statusCode: 422, message: 'Propose at least one candidate date for the core group' })
  }

  const { id, slug } = await createEvent(userId, {
    title: input.title,
    type: 'party',
    description: input.description ?? null,
    posterUrl: input.posterUrl ?? null,
    location: input.location ?? null
  })

  for (const option of input.dateOptions) {
    await addDateOption(userId, slug, option)
  }

  const db = useDb()
  const inviteRows = input.coreInvites.map(friend => ({
    id: createId(),
    eventId: id,
    token: createId(),
    label: friend.name,
    email: friend.email?.toLowerCase() ?? null,
    name: friend.name,
    maxUses: 1,
    tier: 'core' as const,
    createdByUserId: userId
  }))
  await db.insert(tables.invite).values(inviteRows)
  await db.update(tables.event).set({ status: 'polling' }).where(eq(tables.event.id, id))

  return {
    id,
    slug,
    coreInvites: inviteRows.map(i => ({ token: i.token, name: i.name, email: i.email }))
  }
}

/**
 * Stage 2: after the date is locked (published), open the party up — mint the
 * general-wave shareable link (and let the caller email/forward it). The core
 * links keep working; new people land on the RSVP page directly.
 */
export async function openUpParty(
  userId: string,
  slug: string,
  input: { label?: string | null, maxUses?: number | null } = {},
  opts: { dispatch?: EventDispatch } = {}
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  if (ev.status !== 'published') {
    throw createError({ statusCode: 422, message: 'Lock the date first — the party opens up once it is published' })
  }

  const [inserted] = await useDb()
    .insert(tables.invite)
    .values({
      id: createId(),
      eventId: ev.id,
      token: createId(),
      label: input.label ?? 'Open invitation',
      maxUses: input.maxUses ?? null,
      tier: 'general',
      createdByUserId: userId
    })
    .returning()

  if (opts.dispatch) {
    await opts.dispatch('events/party.opened', { eventId: ev.id, inviteId: inserted!.id })
  }
  return inserted!
}
