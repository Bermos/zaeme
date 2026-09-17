import { and, asc, desc, eq, inArray, lte, ne, or, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { contributionTally } from '../../shared/utils/bring-list'
import { isoFromZonedInput, zoneDayKey } from '../../shared/utils/timezone'
import type { SuggestedItem, SuggestionCategory } from '../../shared/utils/bring-list-suggestions'
import {
  attendingHeadcount,
  partitionNewItems,
  suggestBringListItems,
  suggestionsFor
} from '../../shared/utils/bring-list-suggestions'
import { guestUser } from '../database/schema/auth'
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
      // THE FREE-TEXT AMOUNT, and it is not optional to a copy. Most of a real
      // bring list says how much HERE — "two big bowls", "for 8 people" — and
      // never as a count, so leaving this column out made a copy a list of
      // bare nouns. It was invisible to the host who chose it, because the host
      // page does not render this column and `BringList.vue` does: the loss
      // showed up on the guests' invite page and nowhere the host looks.
      quantity: tables.contribution.quantity,
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
    quantity: r.quantity,
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

/* -------------------- the night before, what is missing -------------------- */

/**
 * NOBODY LOOKS AT THE BRING LIST AGAIN (#46).
 *
 * A list is only complete if somebody checks it, and nobody does — so the party
 * has three desserts and no bread. This half of the file answers the two
 * questions the nudge needs and nothing else: WHAT IS STILL MISSING, and WHO
 * SHOULD HEAR ABOUT IT. `server/inngest/functions/bring-list-nudge.ts` is the
 * thin part that sends it.
 *
 * ── ONE OPINION ABOUT COUNTS ───────────────────────────────────────────────
 *
 * Whether an item is finished is `contributionTally` in
 * `shared/utils/bring-list.ts` (#44) and is not re-decided here. `gapLine`
 * calls it and branches on its answer; there is no second arithmetic in this
 * file, no `remaining > 0` written out by hand, and in particular no
 * `quantityNeeded ?? 0`, which would make every free-text item on every list
 * read as finished the moment it was created.
 */

/** One person who said yes, and the link that takes them back to the list. */
export interface BringListNudgeRecipient {
  /** The step id the send is recorded under, so a retry does not re-send. */
  rsvpId: string
  /** Lowercased — it is also the dedupe key. */
  email: string
  name: string | null
  inviteToken: string | null
}

/** Everything the nudge needs, and everything it needs to decide NOT to send. */
export interface BringListNudgePlan {
  eventId: string
  /** Re-read at send time; see the cancellation note on the Inngest function. */
  status: string
  title: string
  slug: string
  startsAt: Date | null
  endsAt: Date | null
  timezone: string | null
  location: string | null
  /**
   * How many items the list holds AT ALL. Zero is "there is no bring list",
   * which is a different answer from "the list is finished" and earns the same
   * silence for a different reason — an event with no list is not a party that
   * forgot, it is a party that did not want one.
   */
  itemCount: number
  /** One line per still-missing item, in list order. Empty means complete. */
  gaps: string[]
  recipients: BringListNudgeRecipient[]
}

/**
 * WHAT ONE STILL-MISSING ITEM READS AS — or null when it is not missing.
 *
 * The nudge names THE GAPS AND NOT THE LIST. A message that repeats all
 * fourteen items is the bring list with extra steps, and the person reading it
 * on a phone the evening before has to diff it themselves, which is exactly the
 * work nobody was doing.
 *
 * Two shapes, because the list has two kinds of item and #44 is emphatic about
 * the difference:
 *
 *  - WITH A STATED NEED, the remainder is the news — "Wine — 2 of 6 bottles
 *    still to go". `unit` is optional free text and the line reads without it.
 *  - WITHOUT ONE there is no remainder to state and never was: the item is
 *    missing when nobody has claimed it, and the useful thing to add is the
 *    free-text amount the host typed — "Bread — two loaves". That column is
 *    where most of a real bring list says how much (#45 lost it in a copy, and
 *    the loss was invisible to the host because the host page does not render
 *    it), so a gap line that dropped it would be the same omission again.
 */
export function gapLine(
  item: Pick<ContributionView, 'title' | 'quantity' | 'unit' | 'quantityNeeded' | 'claims'>
): string | null {
  const { remaining, done } = contributionTally(item.quantityNeeded, item.claims)
  if (done) return null
  // `remaining` is null exactly when nobody stated a need — the branch
  // `contributionTally` documents, read off its answer rather than re-derived
  // from `quantityNeeded` here.
  if (remaining == null) return item.quantity ? `${item.title} — ${item.quantity}` : item.title
  return `${item.title} — ${remaining} of ${item.quantityNeeded}${item.unit ? ` ${item.unit}` : ''} still to go`
}

/** The still-missing items, in the order the list shows them. */
export function bringListGaps(
  items: readonly Pick<ContributionView, 'title' | 'quantity' | 'unit' | 'quantityNeeded' | 'claims'>[]
): string[] {
  return items.map(gapLine).filter((line): line is string => line !== null)
}

/**
 * THE PEOPLE WHO SAID YES, and only them.
 *
 * `summariseRsvps().headcount` in `server/domain/events-data.ts` is NOT reused,
 * for the reason `attendingHeadcount` gives next door: it counts `cheering`,
 * which is "cheering from afar" and means somebody is NOT coming. Mailing them
 * a list of food to bring is the plainest possible version of that bug
 * (Bermos/zaeme#87 is the count itself; this file does not fix it).
 *
 * `maybe` is left out too, and that is the narrower of the two readings. A
 * maybe has not committed to being in the room and a nudge is a request to go
 * shopping, so the conservative answer is to ask the people who said they would
 * be there. Widening it later is additive; un-widening after it ships is not.
 *
 * DEDUPED ON THE LOWERCASED ADDRESS, because one person can hold an account
 * RSVP and a guest RSVP on the same event and must not get two mails. The
 * account's own address wins where there is one, which is the precedence every
 * other send in this app uses.
 */
export function nudgeRecipients(
  rows: readonly {
    rsvp: Pick<typeof tables.rsvp.$inferSelect, 'id' | 'status' | 'guestName' | 'guestEmail'>
    user: Pick<typeof guestUser.$inferSelect, 'name' | 'email'> | null
    invite: Pick<typeof tables.invite.$inferSelect, 'token'> | null
  }[]
): BringListNudgeRecipient[] {
  const out: BringListNudgeRecipient[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.rsvp.status !== 'yes') continue
    const address = r.user?.email ?? r.rsvp.guestEmail
    if (!address) continue
    const email = address.toLowerCase()
    if (seen.has(email)) continue
    seen.add(email)
    out.push({
      rsvpId: r.rsvp.id,
      email,
      name: r.user?.name ?? r.rsvp.guestName ?? null,
      inviteToken: r.invite?.token ?? null
    })
  }
  return out
}

/** What the nudge needs in order to decide; `BringListNudgePlan` satisfies it. */
export interface BringListNudgeFacts {
  status: string
  /** A `Date` from the database, or the ISO string a serialised step hands back. */
  startsAt: Date | string | null
  itemCount: number
  gaps: readonly string[]
  recipients: readonly BringListNudgeRecipient[]
}

/**
 * Whether to send, and why not. The counts ride along either way, so an
 * instance that declines to send still reports what it would have said.
 */
export type BringListNudgeDecision
  = | { send: false, reason: string, gaps: number, recipients: number }
    | { send: true, reason: null, gaps: number, recipients: number }

/**
 * THE WHOLE LADDER, AS A PURE FUNCTION — every reason this job says nothing.
 *
 * It lives here rather than inside the Inngest handler because four of the five
 * acceptance criteria on #46 are refusals, and a refusal written inline in a
 * background job is reachable by nothing: there is no HTTP route to curl and no
 * Inngest server in CI. Here a test executes each rung, and the handler is what
 * it is supposed to be — load, decide, send.
 *
 * THE ORDER IS PART OF THE ANSWER:
 *
 *  - `status !== 'published'` FIRST, because it is the cancellation check and a
 *    cancelled party must not be told about bread whatever else is true of it.
 *  - `already-started` next: the start can be moved after publication and
 *    nothing reschedules the signal, so a nudge really can arrive for a party
 *    that has happened.
 *  - NO LIST and COMPLETE LIST are two refusals and not one, because they are
 *    two different facts that happen to earn the same silence. An event with no
 *    bring list is not a party that forgot.
 *  - `nobody-said-yes` before the transport, because there is no message to
 *    send rather than no way to send it.
 *  - THE TRANSPORT LAST. An instance on the dry run no-ops QUIETLY either way —
 *    nothing is sent, nothing throws, nothing is logged — but asking last keeps
 *    the decision visible on an instance with no mail, which is every instance
 *    between "it builds" and "email works", and is what CI runs against.
 */
export function bringListNudgeDecision(
  plan: BringListNudgeFacts,
  opts: { now: number, mailConfigured: boolean }
): BringListNudgeDecision {
  const counts = { gaps: plan.gaps.length, recipients: plan.recipients.length }
  const no = (reason: string): BringListNudgeDecision => ({ send: false, reason, ...counts })

  if (plan.status !== 'published') return no(`status-${plan.status}`)
  if (!plan.startsAt) return no('no-start')
  if (new Date(plan.startsAt).getTime() <= opts.now) return no('already-started')
  if (plan.itemCount === 0) return no('no-bring-list')
  if (plan.gaps.length === 0) return no('list-complete')
  if (plan.recipients.length === 0) return no('nobody-said-yes')
  if (!opts.mailConfigured) return no('no-mail-transport')
  return { send: true, reason: null, ...counts }
}

/** The hour the nudge lands on, on the event's own wall clock. */
export const NUDGE_HOUR_LOCAL = 18

/**
 * WHEN THE NUDGE GOES OUT: 18:00 IN THE EVENT'S ZONE, THE DAY BEFORE.
 *
 * A fixed offset from the start would put it at 03:00 local for anything that
 * begins in the morning, and a nudge at 03:00 is worse than no nudge — read too
 * late to act on, and it wakes somebody up to tell them about bread. So this is
 * a WALL CLOCK and not a subtraction: the calendar day before the event's own
 * local day, at 18:00 on that day's clock, which is an evening somebody can
 * still get to a shop in.
 *
 * `zoneDayKey` and `isoFromZonedInput` (#31) do the conversion, so the
 * daylight-saving cases are already decided and already pinned by
 * `test/event-timezone.test.ts` rather than re-guessed here: a wall time the
 * spring shift skips resolves forwards, and one the autumn shift repeats
 * resolves to the second of the two.
 *
 * IT IS ALWAYS BEFORE THE EVENT and needs no clamp to say so: 18:00 on the
 * local day before is earlier than 00:00 on the local day of, which is not
 * later than the start. An offset that moved between the two instants changes
 * that by an hour, never by six.
 *
 * Null when there is no start to count back from. A zone `Intl` refuses is not
 * a second null: both helpers fall back to the viewer's own zone, which on the
 * server is the container's — the same thing a null zone does, and the same
 * thing every screen did before #31.
 */
export function bringListNudgeAt(
  startsAt: Date | string | null | undefined,
  timezone: string | null | undefined
): Date | null {
  const day = zoneDayKey(startsAt, timezone)
  if (!day) return null
  const [y, m, d] = day.split('-').map(Number)
  // Through `Date.UTC` rather than string arithmetic, so the first of the month
  // — and the first of January — roll back properly.
  const before = new Date(Date.UTC(y!, m! - 1, d! - 1))
  const pad = (n: number) => String(n).padStart(2, '0')
  const wall = `${before.getUTCFullYear()}-${pad(before.getUTCMonth() + 1)}-${pad(before.getUTCDate())}`
    + `T${pad(NUDGE_HOUR_LOCAL)}:00`
  const iso = isoFromZonedInput(wall, timezone)
  return iso ? new Date(iso) : null
}

/**
 * Everything the nudge needs, in three reads.
 *
 * THE EVENT IS RE-READ HERE rather than trusted from the signal, because the
 * signal was scheduled when the event was published and arrives however many
 * weeks later — by which time it may have been cancelled, completed or moved.
 * That re-read is the whole of "cancelling the event cancels the nudge"; the
 * Inngest function that calls this says why there is nothing else.
 *
 * Null only when the event has been deleted out from under the schedule.
 */
export async function loadBringListNudge(eventId: string): Promise<BringListNudgePlan | null> {
  const db = useDb()
  const [ev] = await db.select().from(tables.event).where(eq(tables.event.id, eventId)).limit(1)
  if (!ev) return null

  const items = await listContributions(ev.id)
  const rows = await db
    .select({ rsvp: tables.rsvp, user: guestUser, invite: tables.invite })
    .from(tables.rsvp)
    .leftJoin(guestUser, eq(tables.rsvp.userId, guestUser.id))
    .leftJoin(tables.invite, eq(tables.rsvp.inviteId, tables.invite.id))
    .where(eq(tables.rsvp.eventId, ev.id))

  return {
    eventId: ev.id,
    status: ev.status,
    title: ev.title,
    slug: ev.slug,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    timezone: ev.timezone,
    location: ev.location,
    itemCount: items.length,
    gaps: bringListGaps(items),
    recipients: nudgeRecipients(rows)
  }
}
