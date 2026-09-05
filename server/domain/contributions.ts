import { and, asc, eq, isNull } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'

/**
 * The bring list (PUBLIC-SITE-PLAN "coordinate food & drinks"): items the host
 * or guests add and guests claim. Claim identity is the same name+email pair
 * RSVPs use; unclaimed = `claimedByEmail` null.
 */

export type ContributionCategory = 'food' | 'drink' | 'other'

export interface ContributionView {
  id: string
  title: string
  category: ContributionCategory
  quantity: string | null
  note: string | null
  claimed: boolean
  claimedByName: string | null
  /** Set only when the viewer's email matches — lets the UI offer "release". */
  claimedByEmail: string | null
}

/** Public-safe contribution list for an event (emails hidden). */
export async function listContributions(eventId: string): Promise<ContributionView[]> {
  const rows = await useDb()
    .select()
    .from(tables.contribution)
    .where(eq(tables.contribution.eventId, eventId))
    .orderBy(asc(tables.contribution.category), asc(tables.contribution.createdAt))
  return rows.map(r => ({
    id: r.id,
    title: r.title,
    category: r.category as ContributionCategory,
    quantity: r.quantity,
    note: r.note,
    claimed: !!r.claimedByEmail,
    claimedByName: r.claimedByName,
    claimedByEmail: r.claimedByEmail
  }))
}

export interface AddContributionInput {
  title: string
  category?: ContributionCategory
  quantity?: string | null
  note?: string | null
}

export interface ContributionActor {
  /** A planner's user id (host side) … */
  userId?: string
  /** … or a guest's identity (guest side). */
  guestName?: string
  guestEmail?: string
}

/** Add an item; a guest actor may claim it immediately ("I'll bring hummus"). */
export async function addContribution(
  eventId: string,
  input: AddContributionInput,
  by: ContributionActor,
  opts: { claim?: boolean } = {}
) {
  const claiming = !!opts.claim && !!by.guestEmail
  const [inserted] = await useDb()
    .insert(tables.contribution)
    .values({
      id: createId(),
      eventId,
      title: input.title,
      category: input.category ?? 'other',
      quantity: input.quantity ?? null,
      note: input.note ?? null,
      createdByUserId: by.userId ?? null,
      createdByGuestEmail: by.guestEmail?.toLowerCase() ?? null,
      claimedByName: claiming ? (by.guestName ?? null) : null,
      claimedByEmail: claiming ? (by.guestEmail!.toLowerCase()) : null,
      claimedAt: claiming ? new Date() : null
    })
    .returning()
  return inserted
}

/** Claim an unclaimed item (409 when someone was faster). */
export async function claimContribution(
  eventId: string,
  contributionId: string,
  claimer: { name: string, email: string }
) {
  const [updated] = await useDb()
    .update(tables.contribution)
    .set({
      claimedByName: claimer.name,
      claimedByEmail: claimer.email.toLowerCase(),
      claimedAt: new Date()
    })
    .where(and(
      eq(tables.contribution.id, contributionId),
      eq(tables.contribution.eventId, eventId),
      // Only an unclaimed row matches — a concurrent claim loses cleanly.
      isNull(tables.contribution.claimedByEmail)
    ))
    .returning()
  if (!updated) {
    throw createError({ statusCode: 409, message: 'Already claimed' })
  }
  return updated
}

/** Release a claim — the claimer themselves, or a planner acting as host. */
export async function releaseContribution(
  eventId: string,
  contributionId: string,
  by: { email?: string, asPlanner?: boolean }
) {
  const db = useDb()
  const [row] = await db
    .select()
    .from(tables.contribution)
    .where(and(eq(tables.contribution.id, contributionId), eq(tables.contribution.eventId, eventId)))
    .limit(1)
  if (!row) throw createError({ statusCode: 404, message: 'Item not found' })
  if (!row.claimedByEmail) return row

  const isClaimer = !!by.email && row.claimedByEmail === by.email.toLowerCase()
  if (!isClaimer && !by.asPlanner) {
    throw createError({ statusCode: 403, message: 'Only the claimer can release this item' })
  }

  const [updated] = await db
    .update(tables.contribution)
    .set({ claimedByName: null, claimedByEmail: null, claimedAt: null })
    .where(eq(tables.contribution.id, contributionId))
    .returning()
  return updated
}

/** Remove an item entirely (owner/co-planner only). */
export async function deleteContribution(userId: string, slug: string, contributionId: string): Promise<void> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .delete(tables.contribution)
    .where(and(eq(tables.contribution.id, contributionId), eq(tables.contribution.eventId, ev.id)))
}
