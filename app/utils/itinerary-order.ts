/**
 * ONE ORDER for an itinerary that now has two kinds of thing in it (#30): the
 * items (arrive, dinner, the hike) and the legs between the places they happen
 * at (the 09:14 to Lugano, the walk back).
 *
 * It is a function rather than four lines inside `EventTimeline.vue` because
 * the merge is the one thing on that screen somebody could point at and call
 * wrong, and a computed property in a template is not something a test can
 * hold. `test/itinerary-order.test.ts` calls it directly; nothing in here
 * throws or touches h3 or the database, and it runs identically during SSR and
 * after a client-side refresh — which is what stops a leg from jumping to a
 * different place in the list the moment the page hydrates.
 *
 * The SERVER is deliberately not a caller. `server/domain/places.ts` answers
 * the places and the legs as they ARE, in `sort_order` — the order the up/down
 * arrows write — and how to show the two lists as one is a decision about a
 * screen, not about the data.
 *
 * THE RULE, and why it is this one rather than "sort everything by time":
 *
 *  1. The items keep the order they arrive in, exactly. That order is the
 *     host's — `sort_order` first, which is what the up/down arrows write, and
 *     a reorder against the clock is a deliberate act, not a mistake to be
 *     corrected by a sort. An itinerary with no legs therefore renders exactly
 *     as it did before this file existed, which is an acceptance criterion of
 *     #30 and not an accident.
 *  2. A leg with a departure time is SLOTTED IN: it appears before the first
 *     item that starts after it. So "09:14 Zug → Lugano" lands between the
 *     09:00 breakfast and the 11:00 check-in, which is where a person reading
 *     the day expects to find it. A leg that departs at exactly an item's start
 *     time goes BEFORE the item: you leave, then you arrive somewhere.
 *  3. A leg that departs after everything with a clock on it goes at the end.
 *  4. Legs with NO departure time come last, in their own `sort_order`. "We
 *     ended up walking back" has no place in the timed sequence and inventing
 *     one for it would be a lie about when it happened.
 *
 * Items with no `startsAt` are not sorting points — a leg is never placed
 * relative to something that does not say when it is — but they keep their
 * position in the item order, which is rule 1.
 */

/** The shape this needs of a timeline item. Anything else rides along. */
export interface OrderableItem {
  id: string
  startsAt?: string | Date | null
}

/** The shape this needs of a leg. */
export interface OrderableLeg {
  id: string
  departsAt?: string | Date | null
  sortOrder?: number | null
  createdAt?: string | Date | null
}

export type ItineraryEntry<I extends OrderableItem, L extends OrderableLeg>
  = | { kind: 'item', id: string, item: I }
    | { kind: 'leg', id: string, leg: L }

/** Milliseconds, or `null` for "no clock on this one". */
function ms(value: string | Date | null | undefined): number | null {
  if (!value) return null
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * The order legs are considered in, and the order the untimed ones end up in.
 *
 * It is the SAME four keys, in the same order, that `loadGeography` reads them
 * in and that `applyItineraryLegMove` renumbers from: `sort_order`, then
 * `departs_at` with nulls last, then `created_at`, then `id`. `id` last and not
 * optional, for the reason `listTimeline` gives: ids are cuid2 and do not sort
 * by age, and rows written in one statement share a `created_at` to the
 * microsecond, so a list that stops one column short of the order the move
 * renumbers from disagrees with it about which row is where — and the first
 * click on the arrows moves a different leg than the one pointed at.
 */
function byLegOrder(a: OrderableLeg, b: OrderableLeg): number {
  const sa = a.sortOrder ?? 0
  const sb = b.sortOrder ?? 0
  if (sa !== sb) return sa - sb
  const da = ms(a.departsAt)
  const db = ms(b.departsAt)
  if (da !== db) {
    if (da === null) return 1
    if (db === null) return -1
    return da - db
  }
  const ca = ms(a.createdAt) ?? 0
  const cb = ms(b.createdAt) ?? 0
  if (ca !== cb) return ca - cb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The items in the order given, with the legs slotted in by departure time and
 * the timeless ones at the end. See the rule at the top of this file.
 */
export function mergeItinerary<I extends OrderableItem, L extends OrderableLeg>(
  items: readonly I[],
  legs: readonly L[]
): Array<ItineraryEntry<I, L>> {
  const ordered = [...legs].sort(byLegOrder)
  const timed = ordered.filter(l => ms(l.departsAt) !== null).sort((a, b) => {
    const d = ms(a.departsAt)! - ms(b.departsAt)!
    return d !== 0 ? d : byLegOrder(a, b)
  })
  const untimed = ordered.filter(l => ms(l.departsAt) === null)

  const out: Array<ItineraryEntry<I, L>> = []
  let next = 0
  for (const item of items) {
    const start = ms(item.startsAt)
    if (start !== null) {
      while (next < timed.length && ms(timed[next]!.departsAt)! <= start) {
        const leg = timed[next++]!
        out.push({ kind: 'leg', id: leg.id, leg })
      }
    }
    out.push({ kind: 'item', id: item.id, item })
  }
  while (next < timed.length) {
    const leg = timed[next++]!
    out.push({ kind: 'leg', id: leg.id, leg })
  }
  for (const leg of untimed) out.push({ kind: 'leg', id: leg.id, leg })
  return out
}
