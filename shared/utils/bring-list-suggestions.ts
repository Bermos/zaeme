/**
 * WHAT A POTLUCK FOR TWELVE NEEDS (#45).
 *
 * A host opening an empty bring list has to invent the whole list. The app
 * already knows the event's type and how many people said yes, which is most of
 * what the answer needs — so this module holds a STATIC, CHECKED-IN set of
 * items per event type and the arithmetic that scales them to the headcount.
 *
 * ── WHAT THIS DELIBERATELY IS NOT ───────────────────────────────────────────
 *
 * There is no template table, no template lifecycle and no configuration
 * screen, because the value here is in NOT TYPING and it evaporates the moment
 * the feature needs its own administration. It is also not a model call: a
 * suggestion that costs a round trip to somebody else's API, can fail, and
 * answers differently on Tuesday is worse at this job than six lines of data.
 * Editing happens on the way in — the host sees the list, changes it, applies
 * it — and afterwards every item is an ordinary `events_contribution` row with
 * nothing marking it as suggested.
 *
 * ── WHY IT IS IN `shared/utils/` ────────────────────────────────────────────
 *
 * Because the screen and the server both have to agree about the numbers. The
 * server scales the preview it hands the host; the host edits it; the server
 * applies what comes back and decides which of it is a duplicate. Nothing in
 * this repository executes a `.vue` file, so a rule written in the component
 * would be guarded by a string match and nothing else — `shared/utils/` is
 * auto-imported into the app and taken by relative path in server code, and
 * `test/bring-list-suggestions.test.ts` RUNS it. Same reason
 * `shared/utils/bring-list.ts` exists, and the numbers here are fed straight
 * into `quantityNeeded`, which is that file's input.
 *
 * ── WHY THE STRINGS ARE HERE AND NOT IN A COMPONENT ─────────────────────────
 *
 * zäme speaks one language today. Every suggested title, unit and note in this
 * file hangs off a stable `key` (`party.wine`, `trip.corkscrew`), so a
 * translation layer arriving later has one module to walk and a key to look up,
 * rather than forty string literals spread across a template. That is the whole
 * of the i18n preparation and it costs nothing now.
 *
 * ── THE RULE THAT MATTERS MOST: NO TYPE PRODUCES A DEAD CONTROL ─────────────
 *
 * The issue names three event types and the schema has five
 * (`hosted | concert | series | trip | party`), and the two it leaves out
 * include `hosted`, WHICH IS THE DEFAULT — an event created without an explicit
 * type is `hosted`, and so is every showing of a series (`scheduleOccurrence`
 * inserts `type: 'hosted'`). Under the issue as written, the most common event
 * on any instance would get a one-tap button that does nothing.
 *
 * So every type answers, and `suggestionsFor` returns items OR a reason, never
 * neither and never both. `reason` is a sentence a screen can show in place of
 * the button; `test/bring-list-suggestions.test.ts` asserts the exclusive-or
 * over every value of the schema enum, so a sixth type added later cannot
 * silently arrive with an empty box.
 */

/** The event types `events_event.type` can hold. Kept in step with the schema. */
export type SuggestibleEventType = 'hosted' | 'concert' | 'series' | 'trip' | 'party'

/** `events_contribution.category`. */
export type SuggestionCategory = 'food' | 'drink' | 'other'

/** One line of the static data: what to suggest, and how it scales. */
export interface SuggestionTemplate {
  /**
   * Stable and type-scoped. It is the identity of this line for a translation
   * file and for the preview the host edits; it is NOT written to the database,
   * where a suggested item is an ordinary row like any other.
   */
  key: string
  title: string
  category: SuggestionCategory
  /** What the count counts — "bottles". `null` for a thing counted in nothing. */
  unit: string | null
  /**
   * How many per attending head — and `null` for a thing ONE OF WHICH IS ENOUGH
   * however many people come. A corkscrew is the reason this is nullable rather
   * than a number that happens to be small: `1/12` would make a second one
   * appear the moment a thirteenth person said yes, which is not a fact about
   * corkscrews.
   */
  perPerson: number | null
  /** Never suggest fewer than this, whatever the headcount works out to. */
  minimum: number
  /** An optional hint that rides along onto the item's `note`. */
  note?: string
}

/** What a type suggests: items, or a reason there are none. Never both. */
export interface SuggestionSet {
  items: readonly SuggestionTemplate[]
  /**
   * Why there is nothing to suggest, as a sentence to SHOW. Non-null exactly
   * when `items` is empty — a screen that gets a reason renders the reason and
   * no button, which is the difference between "nothing to bring to a gig" and
   * a control that looks live and does nothing.
   */
  reason: string | null
}

/**
 * THE STATIC DATA, and the five decisions in it.
 *
 * `hosted` — THE DEFAULT, and therefore the most common event an instance
 * holds. It is also what every cinema night actually is: `scheduleOccurrence`
 * creates each showing of a series with `type: 'hosted'`. So this is the issue's
 * film-night list ("something fizzy, something salty") written generically
 * enough that it is also right for a dinner, a games evening or a birthday —
 * the four things somebody brings to a gathering at somebody else's flat.
 *
 * `party` — the issue's own example, and the one the acceptance criterion names:
 * twelve yes-RSVPs must produce plausible quantities. Half a bottle of wine and
 * two beers a head, a bag of ice per four, and the cups everybody forgets.
 *
 * `trip` — breakfast, which is the meal a self-catering trip actually has to
 * organise, plus the corkscrew: the flat item, one of which is enough for a
 * chalet of six or of sixteen.
 *
 * `series` — NOTHING, with a reason. A series is the standing group, not an
 * occasion: its claims would belong to no particular Friday, and the host page
 * renders no bring list on a container at all (`v-if="!isSeries && !isConcert"`
 * on `app/pages/host/[slug].vue`). Its showings are `hosted` and get the list
 * above.
 *
 * `concert` — NOTHING, with a reason. There is genuinely nothing to bring to a
 * gig, and the honest answer is a sentence rather than an empty box.
 */
export const SUGGESTIONS: Readonly<Record<SuggestibleEventType, SuggestionSet>> = {
  hosted: {
    reason: null,
    items: [
      { key: 'hosted.nibbles', title: 'Something to nibble', category: 'food', unit: 'bowls', perPerson: 0.5, minimum: 2 },
      { key: 'hosted.fizzy', title: 'Something fizzy', category: 'drink', unit: 'bottles', perPerson: 0.5, minimum: 2 },
      { key: 'hosted.salty', title: 'Something salty', category: 'food', unit: 'bags', perPerson: 0.5, minimum: 2 },
      { key: 'hosted.sweet', title: 'Something sweet', category: 'food', unit: 'portions', perPerson: 1, minimum: 4 }
    ]
  },
  party: {
    reason: null,
    items: [
      { key: 'party.wine', title: 'Wine', category: 'drink', unit: 'bottles', perPerson: 0.5, minimum: 2 },
      { key: 'party.beer', title: 'Beer', category: 'drink', unit: 'bottles', perPerson: 2, minimum: 6 },
      { key: 'party.soft', title: 'Something non-alcoholic', category: 'drink', unit: 'bottles', perPerson: 0.5, minimum: 2 },
      { key: 'party.ice', title: 'Ice', category: 'other', unit: 'bags', perPerson: 0.25, minimum: 1 },
      { key: 'party.snacks', title: 'Crisps and nuts', category: 'food', unit: 'bowls', perPerson: 0.5, minimum: 2 },
      { key: 'party.cups', title: 'Cups', category: 'other', unit: 'cups', perPerson: 1.5, minimum: 10, note: 'The thing everyone forgets' }
    ]
  },
  trip: {
    reason: null,
    items: [
      { key: 'trip.bread', title: 'Bread for breakfast', category: 'food', unit: 'loaves', perPerson: 0.5, minimum: 1 },
      { key: 'trip.coffee', title: 'Coffee', category: 'drink', unit: 'packs', perPerson: 0.25, minimum: 1 },
      { key: 'trip.milk', title: 'Milk', category: 'drink', unit: 'litres', perPerson: 0.25, minimum: 1 },
      // JARS ARE EATEN, CORKSCREWS ARE NOT. `perPerson: null` is reserved for a
      // thing one of which is enough however many come, and this line had it by
      // mistake: four people and forty both got two jars, beside three
      // neighbours that all scaled. A quarter of a jar a head over a few days
      // puts a chalet of eight on two and a party of twenty on five.
      { key: 'trip.spreads', title: 'Jam and butter', category: 'food', unit: 'jars', perPerson: 0.25, minimum: 2 },
      { key: 'trip.corkscrew', title: 'A corkscrew', category: 'other', unit: null, perPerson: null, minimum: 1, note: 'One is plenty' }
    ]
  },
  series: {
    items: [],
    reason: 'A series is the standing group rather than an evening — each showing carries its own bring list, so suggest one there.'
  },
  concert: {
    items: [],
    reason: 'There is nothing to bring to a gig: the ticket is the thing and the bar is the bar.'
  }
}

/** The set for a type, falling back to the default type for anything unknown. */
export function suggestionsFor(type: string): SuggestionSet {
  return SUGGESTIONS[type as SuggestibleEventType] ?? SUGGESTIONS.hosted
}

/**
 * HOW MANY PEOPLE THIS LIST IS FOR: the yes-RSVPs, plus their plus-ones.
 *
 * `summariseRsvps().headcount` in `server/domain/events-data.ts` counts
 * `cheering` too and is NOT reused here on purpose. "Cheering from afar" is
 * offered on concerts alone (`RsvpCard.vue`) and means somebody is not coming —
 * they eat nothing, so they are not a head a bring list scales to. The
 * distinction cannot bite today, because a concert gets no list at all; it is
 * written this way so it stays right if that status ever spreads.
 *
 * `maybe` is not counted either. Catering for a maybe is a judgement the host
 * makes, and the number is editable before it is applied.
 */
export function attendingHeadcount(
  rsvps: readonly { status: string, plusOne?: boolean | null }[]
): number {
  let heads = 0
  for (const r of rsvps) {
    if (r.status === 'yes') heads += 1 + (r.plusOne ? 1 : 0)
  }
  return heads
}

/**
 * HOW MANY OF ONE TEMPLATE A GIVEN HEADCOUNT WANTS.
 *
 * `ceil`, not `round`: running out is worse than having one left over, and the
 * remainder a bring list shows is a request rather than a promise.
 *
 * A HEADCOUNT OF ZERO IS FLOORED AT ONE, which is the case a host meets first —
 * an event published this morning has no yes-RSVPs yet, and "0 bottles needed"
 * on every line is a one-tap button that produces a list saying nobody should
 * bring anything. One head gives each template its `minimum`, which is a small
 * honest list the host then edits upward. The count is editable on the way in
 * precisely so this guess never has to be right.
 */
export function suggestedQuantity(
  template: Pick<SuggestionTemplate, 'perPerson' | 'minimum'>,
  headcount: number
): number {
  if (template.perPerson == null) return template.minimum
  const heads = Math.max(1, Math.floor(headcount) || 0)
  return Math.max(template.minimum, Math.ceil(heads * template.perPerson))
}

/** One row of the editable preview a host is shown before anything is written. */
export interface SuggestedItem {
  /**
   * The template's key, or `copy:<source item id>` when this row came from a
   * past event. It identifies the row in the preview and is never stored.
   */
  key: string
  title: string
  category: SuggestionCategory
  unit: string | null
  quantityNeeded: number | null
  /**
   * THE FREE-TEXT AMOUNT — "two big bowls", "for 8 people" — and NOT the count
   * beside it. `null` for every static suggestion, because a scaled line states
   * its amount as a number; it exists on this shape for the COPY, where most of
   * what a real bring list says about how much lives in this column and nowhere
   * else.
   *
   * Dropping it made a copy look complete to the person who chose it and
   * lossy to everybody else: `app/pages/host/[slug].vue` never renders this
   * column, and `app/components/BringList.vue` renders it to every invite
   * holder — so "Crisps — two big bowls" arrived on the guests' page as
   * "Crisps" while the host's page looked right.
   */
  quantity: string | null
  note: string | null
}

/**
 * The static set for a type, scaled — the preview before the host touches it.
 *
 * `quantity` is `null` on every line here on purpose: these say how much as a
 * NUMBER (`quantityNeeded` + `unit`), which is the whole point of scaling them,
 * and a free-text amount beside a count is two answers to one question.
 */
export function suggestBringListItems(type: string, headcount: number): SuggestedItem[] {
  return suggestionsFor(type).items.map(t => ({
    key: t.key,
    title: t.title,
    category: t.category,
    unit: t.unit,
    quantityNeeded: suggestedQuantity(t, headcount),
    quantity: null,
    note: t.note ?? null
  }))
}

/**
 * THE RULE THAT STOPS APPLYING TWICE FROM DUPLICATING.
 *
 * An acceptance criterion, and the mistake it guards is the obvious one: the
 * host taps "Add these", the request is slow, they tap again, and the list has
 * two of everything. There is no marker column and no migration in this issue,
 * so the identity of a bring-list item is what it has always been — its TITLE
 * on its event, compared case-insensitively with runs of whitespace collapsed,
 * because "Ice " and "ice" are the same thing to ask somebody for.
 *
 * MATCHING ON THE TITLE ALONE, not on the title and the count, is deliberate.
 * A host who applied a suggestion, then lowered "Wine" from 6 to 4, and then
 * applied again must not get a second Wine — and must not have their 4 pushed
 * back to 6 either, which is why the duplicate is SKIPPED rather than updated.
 * An item already on the list wins over a suggestion about it, always.
 */
export function bringListKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Which of `items` are not already on `existingTitles`, and which are — in one
 * pass, so the two answers cannot disagree. The suggestion itself is
 * de-duplicated too: a past event with "Ice" and "ice " on it is one Ice here.
 */
export function partitionNewItems<T extends { title: string }>(
  items: readonly T[],
  existingTitles: readonly string[]
): { fresh: T[], duplicates: T[] } {
  const seen = new Set(existingTitles.map(bringListKey))
  const fresh: T[] = []
  const duplicates: T[] = []
  for (const item of items) {
    const key = bringListKey(item.title)
    if (seen.has(key)) duplicates.push(item)
    else {
      seen.add(key)
      fresh.push(item)
    }
  }
  return { fresh, duplicates }
}

/**
 * WHEN THE SUGGESTION PANEL OPENS BY ITSELF. The issue asks for one tap "on an
 * empty or thin bring list", so the host page opens it unasked below this many
 * items and keeps it behind a button above it. It is not a gate: suggesting
 * stays available on a full list, where it is harmless because every item on
 * it is already a duplicate and will be skipped.
 */
export const THIN_BRING_LIST = 3

export function isThinBringList(itemCount: number): boolean {
  return itemCount < THIN_BRING_LIST
}

/**
 * THE TWO SENTENCES THE PANEL SAYS, here rather than in the template for the
 * reason every other rule in this file is: nothing executes a `.vue`, and both
 * of these have a case that is wrong in a way a screenshot would not catch.
 *
 * The first is what the counts were scaled to. NOBODY HAVING SAID YES YET IS
 * THE COMMON CASE on a list published this morning, and it has to read as
 * "these are starter amounts" rather than as a confident statement about a
 * party of one — `suggestedQuantity` floors the headcount at 1, so the numbers
 * beside this sentence are each template's minimum.
 */
export function headcountLine(headcount: number): string {
  if (headcount < 1) return 'Nobody has said yes yet — these are starter amounts, change anything.'
  if (headcount === 1) return 'Scaled to the 1 person who has said yes.'
  return `Scaled to the ${headcount} people who have said yes.`
}

/**
 * The second is what an apply did. THE CASE THAT MATTERS IS `added === 0`:
 * tapping a second time is meant to change nothing, and a screen that answers
 * "Added 0 items" reads like a failure rather than like the guarantee it is.
 */
/**
 * WHAT AN EMPTIED COUNT FIELD MEANS: no stated count, which is a real thing to
 * say about a bring-list item and is what `quantityNeeded: null` has meant
 * since #44 ("some crisps").
 *
 * It is a function rather than an expression in the panel because Vue's
 * `v-model.number` hands back `''` for a cleared input, and `''` is neither a
 * number nor null: posted as it stands it fails the route's zod schema, so a
 * host who clears one count gets "could not add those" for the whole list and
 * no clue which line did it. The wrong version is silent in every static check
 * — the field is typed `number | null`, so nothing type-checks the `''` that
 * actually arrives at runtime.
 */
export function countFieldValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value)
  return null
}

export function applySummary(added: number, skipped: number): string {
  const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`
  if (added === 0 && skipped === 0) return 'Nothing to add.'
  if (added === 0) return `Already on the list — nothing added, ${items(skipped)} left as they were.`
  if (skipped === 0) return `Added ${items(added)}.`
  return `Added ${items(added)} — ${items(skipped)} were already on the list.`
}
