import { and, asc, desc, eq, inArray, lte, ne, or, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { contributionTally } from '../../shared/utils/bring-list'
import type { SuggestedItem, SuggestionCategory } from '../../shared/utils/bring-list-suggestions'
import {
  attendingHeadcount,
  partitionNewItems,
  suggestBringListItems,
  suggestionsFor
} from '../../shared/utils/bring-list-suggestions'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'

/**
 * The bring list (PUBLIC-SITE-PLAN "coordinate food & drinks"): items the host
 * or guests add and guests claim. Claim identity is the same name+email pair
 * RSVPs use.
 *
 * SINCE #44 A CLAIM IS A ROW, not three columns on the item — so an item can be
 * claimed by two people, and an item that says how many are wanted can be
 * partly claimed. Whether an item is DONE is `contributionTally`
 * (`shared/utils/bring-list.ts`) and not a column: with a stated need it is
 * "the claims meet it", and without one it is "somebody claimed it", which is
 * exactly what `claimed` meant before this issue.
 */

export type ContributionCategory = 'food' | 'drink' | 'other'

/** One person's claim on one item. */
export interface ContributionClaimView {
  name: string
  /**
   * Lowercased. It reaches the guest surface, which is how `BringList.vue` can
   * tell the viewer which claim is their own and offer to release it — the
   * capability URL carries no identity, so the screen compares the address the
   * person typed against this one. It is the same field the single
   * `claimedByEmail` put there before #44, one per claimer instead of one per
   * item (Bermos/zaeme#83 is the question of withholding it).
   */
  email: string
  quantityClaimed: number
  claimedAt: Date
}

export interface ContributionView {
  id: string
  title: string
  category: ContributionCategory
  /** The free-text amount — "some crisps". Unrelated to the count below. */
  quantity: string | null
  /** How many are wanted, or `null` when nobody said — see `claimed`. */
  quantityNeeded: number | null
  unit: string | null
  note: string | null
  /** Everything claimed on this item, across every claimer. */
  quantityClaimed: number
  /** How many are still wanted; `null` when there is no stated need. */
  quantityRemaining: number | null
  /**
   * Whether this item is finished. An item with no `quantityNeeded` is finished
   * when anybody has claimed it, which is what this field has always meant.
   */
  claimed: boolean
  claims: ContributionClaimView[]
}

/** The bring list for an event, with every claim on every item. */
export async function listContributions(eventId: string): Promise<ContributionView[]> {
  const db = useDb()
  const rows = await db
    .select()
    .from(tables.contribution)
    .where(eq(tables.contribution.eventId, eventId))
    .orderBy(asc(tables.contribution.category), asc(tables.contribution.createdAt))
  // THE CLAIMS ARE READ SECOND, deliberately. The map is keyed by item and
  // looked up once per item, so reading it after the items makes it a superset:
  // an item created by a concurrent writer between the two reads is simply not
  // in the list, where the other order would show an item that already has
  // claims as unclaimed.
  const claims = rows.length
    ? await db
        .select()
        .from(tables.contributionClaim)
        .where(inArray(tables.contributionClaim.contributionId, rows.map(r => r.id)))
        .orderBy(asc(tables.contributionClaim.claimedAt))
    : []

  const byItem = new Map<string, ContributionClaimView[]>()
  for (const c of claims) {
    const view = { name: c.name, email: c.email, quantityClaimed: c.quantityClaimed, claimedAt: c.claimedAt }
    const list = byItem.get(c.contributionId)
    if (list) list.push(view)
    else byItem.set(c.contributionId, [view])
  }

  return rows.map((r) => {
    const mine = byItem.get(r.id) ?? []
    const tally = contributionTally(r.quantityNeeded, mine)
    return {
      id: r.id,
      title: r.title,
      category: r.category as ContributionCategory,
      quantity: r.quantity,
      quantityNeeded: r.quantityNeeded,
      unit: r.unit,
      note: r.note,
      quantityClaimed: tally.claimedTotal,
      quantityRemaining: tally.remaining,
      claimed: tally.done,
      claims: mine
    }
  })
}

/** One item with its claims, or a 404 — what every write answers with. */
async function loadContribution(eventId: string, contributionId: string): Promise<ContributionView> {
  const found = (await listContributions(eventId)).find(c => c.id === contributionId)
  if (!found) throw createError({ statusCode: 404, message: 'Item not found' })
  return found
}

export interface AddContributionInput {
  title: string
  category?: ContributionCategory
  quantity?: string | null
  /** How many are wanted. Omit for the free-text items this list is mostly made of. */
  quantityNeeded?: number | null
  unit?: string | null
  note?: string | null
}

export interface ContributionActor {
  /** A planner's user id (host side) … */
  userId?: string
  /** … or a guest's identity (guest side). */
  guestName?: string
  guestEmail?: string
}

/**
 * Add an item; a guest actor may claim it immediately ("I'll bring hummus").
 *
 * HOW MUCH THAT IMMEDIATE CLAIM IS FOR: `claimQuantity` when the caller says,
 * otherwise the whole stated need, otherwise one. A guest adding "6 bottles" on
 * their own invite page is saying they will bring six — they are stating the
 * need and meeting it in one gesture — while a planner seeding "6 bottles" for
 * others to claim does not claim at all, which is the `claim` flag and not this
 * number.
 */
export async function addContribution(
  eventId: string,
  input: AddContributionInput,
  by: ContributionActor,
  opts: { claim?: boolean, claimQuantity?: number } = {}
) {
  const claiming = !!opts.claim && !!by.guestEmail
  const id = createId()
  // ONE TRANSACTION for the two writes: an item that exists with the claim its
  // author meant to make missing is the one outcome a person cannot tell from
  // "somebody took it already".
  await useDb().transaction(async (tx) => {
    await tx
      .insert(tables.contribution)
      .values({
        id,
        eventId,
        title: input.title,
        category: input.category ?? 'other',
        quantity: input.quantity ?? null,
        quantityNeeded: input.quantityNeeded ?? null,
        unit: input.unit ?? null,
        note: input.note ?? null,
        createdByUserId: by.userId ?? null,
        createdByGuestEmail: by.guestEmail?.toLowerCase() ?? null
      })
    if (claiming) {
      await tx.insert(tables.contributionClaim).values({
        id: createId(),
        eventId,
        contributionId: id,
        name: by.guestName ?? by.guestEmail!,
        email: by.guestEmail!.toLowerCase(),
        quantityClaimed: opts.claimQuantity ?? input.quantityNeeded ?? 1
      })
    }
  })
  return loadContribution(eventId, id)
}

/**
 * Claim some of an item.
 *
 * THE ONE REFUSAL, and it is the old one generalised rather than a new rule: an
 * item that is already DONE cannot be claimed by somebody who holds no claim on
 * it (409, "someone was faster"). On an item with no stated need that is word
 * for word the behaviour before #44 — the first claimer takes it and a second
 * gets a 409 — and on an item that says six bottles it means the six are
 * spoken for.
 *
 * A CLAIMER ADJUSTING THEIR OWN NUMBER IS NOT REFUSED, on a done item either:
 * `(contribution_id, email)` is unique, so this upserts, and dropping from six
 * to three has to be possible or an item can never be re-opened except by
 * releasing it entirely — which tells the whole party, for as long as it takes
 * to claim it again, that nobody is bringing the thing.
 *
 * `BringList.vue` REACHES THIS, and that sentence is load-bearing rather than
 * decorative: its `canAdjust` offers the number field and the button to a
 * claimer on an item that is already done, which is the only caller that walks
 * this branch (`/api/v1` has no claim verb at all, and the invite route is the
 * only other way in). An earlier revision of this comment argued for the branch
 * while both controls were hidden behind `!c.claimed` — live on the wire and
 * dead from the product, which is a paragraph defending a path nobody could
 * walk. If the screen ever stops offering it, delete the branch or say here
 * that it is unreachable; do not leave this paragraph standing over nothing.
 *
 * OVER-CLAIMING IS NOT REFUSED. Ten of six bottles is a party, not an error;
 * `contributionTally` clamps the remainder at zero.
 *
 * THE `for update` IS THE OLD `isNull(claimedByEmail)` WHERE-CLAUSE'S JOB. That
 * clause made "claim it only if nobody has" one statement, so a concurrent
 * claim lost cleanly with a 409. Reading the claims and then inserting is two,
 * and two people tapping at once on an item with no stated need would both read
 * "nobody has it" and both end up on it. Locking the ITEM row serialises every
 * claim on it, which is the same guarantee for a rule that is now arithmetic
 * over other rows rather than a single column.
 */
export async function claimContribution(
  eventId: string,
  contributionId: string,
  claimer: { name: string, email: string, quantity?: number }
) {
  const email = claimer.email.toLowerCase()
  const quantity = claimer.quantity ?? 1
  await useDb().transaction(async (tx) => {
    const [item] = await tx
      .select({ quantityNeeded: tables.contribution.quantityNeeded })
      .from(tables.contribution)
      .where(and(
        eq(tables.contribution.id, contributionId),
        eq(tables.contribution.eventId, eventId)
      ))
      .for('update')
      .limit(1)
    if (!item) throw createError({ statusCode: 404, message: 'Item not found' })

    const held = await tx
      .select({
        email: tables.contributionClaim.email,
        quantityClaimed: tables.contributionClaim.quantityClaimed
      })
      .from(tables.contributionClaim)
      .where(eq(tables.contributionClaim.contributionId, contributionId))
    if (contributionTally(item.quantityNeeded, held).done && !held.some(c => c.email === email)) {
      throw createError({ statusCode: 409, message: 'Already claimed' })
    }

    await tx
      .insert(tables.contributionClaim)
      .values({ id: createId(), eventId, contributionId, name: claimer.name, email, quantityClaimed: quantity })
      .onConflictDoUpdate({
        target: [tables.contributionClaim.contributionId, tables.contributionClaim.email],
        set: { name: claimer.name, quantityClaimed: quantity, claimedAt: new Date() }
      })
  })
  return loadContribution(eventId, contributionId)
}

/**
 * Release a claim — the row belonging to this email, which over the capability
 * URL is the only row the caller can name (the body asserts the identity, the
 * link does not carry one). Releasing something nobody claimed is a no-op
 * rather than an error, so a double-tap is not a failure.
 */
export async function releaseContribution(
  eventId: string,
  contributionId: string,
  by: { email: string }
) {
  await loadContribution(eventId, contributionId)
  await useDb()
    .delete(tables.contributionClaim)
    .where(and(
      eq(tables.contributionClaim.contributionId, contributionId),
      eq(tables.contributionClaim.eventId, eventId),
      eq(tables.contributionClaim.email, by.email.toLowerCase())
    ))
  return loadContribution(eventId, contributionId)
}

/** Remove an item entirely (owner/co-planner only). Its claims cascade. */
export async function deleteContribution(userId: string, slug: string, contributionId: string): Promise<void> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .delete(tables.contribution)
    .where(and(eq(tables.contribution.id, contributionId), eq(tables.contribution.eventId, ev.id)))
}

/* --------------------------- planner-scoped shape --------------------------- */

/** The bring-list for a planner of the event — the `(userId, slug)` shape. */
export async function listContributionsForPlanner(userId: string, slug: string): Promise<ContributionView[]> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return listContributions(ev.id)
}

/** Add a bring-list item as a planner (owner/co-planner only). */
export async function addContributionAsPlanner(userId: string, slug: string, input: AddContributionInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  return addContribution(ev.id, input, { userId })
}

/* ------------------------- suggesting a whole list ------------------------- */

/**
 * NOBODY KNOWS WHAT A POTLUCK FOR TWELVE NEEDS (#45).
 *
 * One tap on an empty or thin bring list, producing a list the host edits
 * before any of it is written. Two sources, one shape and one write path:
 *
 *  - the STATIC data in `shared/utils/bring-list-suggestions.ts`, scaled to the
 *    yes-RSVPs; and
 *  - a COPY of another event of the same type this host has already run.
 *
 * THE COPY IS A COPY AND NOT A TEMPLATE, which is the distinction the issue
 * draws and the reason there is no new table and no migration here: nothing
 * links the new items to the old event, nothing has to be kept up to date, and
 * deleting the source afterwards costs this event nothing. It is a one-time
 * read of a past list, in the same preview shape the static suggestions arrive
 * in, and it BRINGS THE ITEMS AND NOT THE CLAIMS — which is guaranteed by the
 * shape rather than by remembering: `SuggestedItem` has no field a claim could
 * ride in on, `copyableItems` never names `events_contribution_claim`, and
 * `applyBringListSuggestion` writes to `events_contribution` alone. Last year's
 * guests are not this year's.
 */
export interface BringListSource {
  slug: string
  title: string
  startsAt: Date | null
  itemCount: number
}

export interface BringListSuggestion {
  /** Where the preview came from: the checked-in data, or a past event. */
  source: 'static' | 'event'
  /** The past event it was copied from, when `source` is `'event'`. */
  fromSlug: string | null
  eventType: string
  /** The yes-RSVPs (plus their +1s) the counts below were scaled to. */
  headcount: number
  /**
   * Why there is nothing to suggest, or `null`. Non-empty items and a reason
   * are mutually exclusive — a screen with a reason shows the sentence and NO
   * button, which is what stops a concert getting a control that does nothing.
   */
  reason: string | null
  items: SuggestedItem[]
}

/**
 * Other events of the SAME TYPE this planner has already run, that have a bring
 * list worth copying.
 *
 * "ALREADY RUN" IS THE CONSERVATIVE READING of the issue's "a host who has run
 * a party before": started, or marked completed. An event with no date at all
 * is not offered, because a draft nobody has scheduled is not a past party. The
 * looser reading — any other event of the type, upcoming ones included — would
 * also serve somebody running two parties in one month, and is left for the
 * owner to ask for.
 *
 * `exists (...)` in the WHERE rather than a count filtered afterwards:
 * filtering a limited page in JS can return nothing while offerable events sit
 * on the next page.
 */
export async function listBringListSources(userId: string, slug: string): Promise<BringListSource[]> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return useDb()
    .select({
      slug: tables.event.slug,
      title: tables.event.title,
      startsAt: tables.event.startsAt,
      itemCount: sql<number>`(select count(*)::int from events_contribution c where c.event_id = events_event.id)`
    })
    .from(tables.event)
    .innerJoin(tables.eventPlanner, eq(tables.eventPlanner.eventId, tables.event.id))
    .where(and(
      eq(tables.eventPlanner.userId, userId),
      eq(tables.event.type, ev.type),
      ne(tables.event.id, ev.id),
      or(lte(tables.event.startsAt, new Date()), eq(tables.event.status, 'completed')),
      sql`exists (select 1 from events_contribution c where c.event_id = events_event.id)`
    ))
    .orderBy(desc(tables.event.startsAt))
    .limit(20)
}

/**
 * The editable preview. `from` copies a past event's items instead of scaling
 * the static set; the headcount is reported either way, because it is what the
 * static counts were computed from and what a host judges them against.
 */
export async function suggestBringList(
  userId: string,
  slug: string,
  opts: { from?: string | null } = {}
): Promise<BringListSuggestion> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const rsvps = await useDb()
    .select({ status: tables.rsvp.status, plusOne: tables.rsvp.plusOne })
    .from(tables.rsvp)
    .where(eq(tables.rsvp.eventId, ev.id))
  const headcount = attendingHeadcount(rsvps)

  if (opts.from) {
    return {
      source: 'event',
      fromSlug: opts.from,
      eventType: ev.type,
      headcount,
      reason: null,
      items: await copyableItems(userId, ev, opts.from)
    }
  }
  return {
    source: 'static',
    fromSlug: null,
    eventType: ev.type,
    headcount,
    reason: suggestionsFor(ev.type).reason,
    items: suggestBringListItems(ev.type, headcount)
  }
}

/**
 * A past event's items as preview rows. THE CLAIMS ARE NOT SELECTED AT ALL —
 * not filtered out downstream, not nulled on the way past: this query names
 * five columns of `events_contribution` and `events_contribution_claim` appears
 * nowhere in it. There is no path from here to somebody else's name.
 */
async function copyableItems(
  userId: string,
  target: { id: string, type: string },
  fromSlug: string
): Promise<SuggestedItem[]> {
  const source = await loadEventBySlug(fromSlug)
  if (source.id === target.id) {
    throw createError({ statusCode: 422, message: 'That is this event — pick another one to copy from' })
  }
  // The planner has to be a planner THERE too. Without this, any slug on the
  // instance would hand its bring list to anybody who could name it.
  await assertPlanner(source.id, userId)
  if (source.type !== target.type) {
    throw createError({
      statusCode: 422,
      message: `A ${source.type} list does not fit a ${target.type} — copy from another ${target.type}`
    })
  }
  const rows = await useDb()
    .select({
      id: tables.contribution.id,
      title: tables.contribution.title,
      category: tables.contribution.category,
      unit: tables.contribution.unit,
      quantityNeeded: tables.contribution.quantityNeeded,
      note: tables.contribution.note
    })
    .from(tables.contribution)
    .where(eq(tables.contribution.eventId, source.id))
    .orderBy(asc(tables.contribution.category), asc(tables.contribution.createdAt))
  return rows.map(r => ({
    key: `copy:${r.id}`,
    title: r.title,
    category: r.category as SuggestionCategory,
    unit: r.unit,
    quantityNeeded: r.quantityNeeded,
    note: r.note
  }))
}

export interface ApplyBringListResult {
  added: number
  /** The titles already on the list, left exactly as they were. */
  skipped: string[]
  contributions: ContributionView[]
}

/**
 * Write the preview the host edited. Nothing is claimed and nothing is updated:
 * items that are new are inserted, and items whose title is already on this
 * event are SKIPPED and reported back.
 *
 * APPLYING TWICE MUST NOT DUPLICATE is an acceptance criterion, and the two
 * taps that make it hard are simultaneous ones — a slow request and an
 * impatient thumb. Reading the titles and then inserting is two statements, so
 * both requests would read "no Wine" and both would insert one. There is no
 * unique index to lean on (this issue adds no migration, and a unique
 * `(event_id, lower(title))` would also refuse a PERSON typing a second Wine,
 * which is their business), so the event row is locked `for update` for the
 * duration — the same lock `changeEventCurrency` takes, and the only other
 * writer of it. Every apply on one event therefore serialises, and the second
 * sees the first's rows.
 *
 * SKIPPED RATHER THAN UPDATED, deliberately: a host who lowered Wine from 6 to
 * 4 and tapped again must not have their 4 pushed back up to 6. What is on the
 * list wins over a suggestion about it.
 */
export async function applyBringListSuggestion(
  userId: string,
  slug: string,
  items: readonly AddContributionInput[]
): Promise<ApplyBringListResult> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  let added = 0
  let skipped: string[] = []
  await useDb().transaction(async (tx) => {
    const [held] = await tx
      .select({ id: tables.event.id })
      .from(tables.event)
      .where(eq(tables.event.id, ev.id))
      .for('update')
      .limit(1)
    if (!held) throw createError({ statusCode: 404, message: 'Event not found' })

    const existing = await tx
      .select({ title: tables.contribution.title })
      .from(tables.contribution)
      .where(eq(tables.contribution.eventId, ev.id))
    const split = partitionNewItems(items, existing.map(r => r.title))
    skipped = split.duplicates.map(i => i.title)
    added = split.fresh.length
    if (split.fresh.length) {
      await tx.insert(tables.contribution).values(split.fresh.map(i => ({
        id: createId(),
        eventId: ev.id,
        title: i.title,
        category: i.category ?? 'other',
        quantity: i.quantity ?? null,
        quantityNeeded: i.quantityNeeded ?? null,
        unit: i.unit ?? null,
        note: i.note ?? null,
        createdByUserId: userId,
        createdByGuestEmail: null
      })))
    }
  })
  return { added, skipped, contributions: await listContributions(ev.id) }
}
