import type { TicketDetailFields } from './ticket-detail'

/**
 * WHAT IS PINNED TO THIS STEP OF THE PLAN (#38).
 *
 * `events_media.timeline_item_id` has pinned a ticket to "the 09:14 to Porto"
 * since the transplant and no screen has ever said it back — the column was
 * projected onto `/api/v1` for Enterprise and dropped from both of the reads a
 * PERSON looks at. So the data model has known which ticket belongs to which
 * step for months, and the itinerary has been a list of titles and times.
 *
 * ── WHY THE RULE IS A FUNCTION IN `shared/utils/` AND NOT SIX LINES IN A CARD ─
 *
 * The same reason `ticket-scope.ts` and `ticket-detail.ts` beside it are, and
 * it is not a style preference: THE MEDIA LIST IS FETCHED BY THE BROWSER. Media
 * URLs are short-lived signatures, so `app/pages/i/[token].vue` loads them
 * `onMounted` and no SSR'd HTML carries one. `pnpm smoke:api` can therefore
 * prove the server answers with `timelineItemId` on every item and is
 * structurally incapable of seeing the itinerary render the wrong subset of
 * them, or render none at all. A check that watches the wire while the defect
 * lives in the renderer is a check that would have passed — which is exactly
 * how #31 shipped, and how #77's review deleted a `:timezone` binding through a
 * green pipeline.
 *
 * So the grouping, the normalisation and the type rule live here, where
 * `test/pinned-media.test.ts` executes them and pins the three call sites that
 * feed them.
 *
 * ── AND THE GUEST RULE IS #37's, NOT A SECOND, QUIETER ONE ──────────────────
 *
 * Every invite holder reaches every ticket on the event, marked `mine` or not
 * and labelled with who it is for. A pinned ticket is the same ticket: it is
 * shown on the step to everybody, with `ticketAssigneeLine` (the same sentence
 * the Tickets section uses) saying whose it is. Filtering the itinerary down to
 * `mine` would restore the pre-#37 behaviour in a second place — the one where
 * four friends at a barrier are reading the plan rather than the ticket list.
 */

/** The media types a planner may pin to a step, and the only ones rendered there. */
export const TIMELINE_PINNABLE_TYPES = ['ticket', 'document'] as const

export type PinnableMediaType = typeof TIMELINE_PINNABLE_TYPES[number]

/** The least an item has to carry to be grouped by the step it is pinned to. */
export interface PinnableMedia {
  id: string
  type: string
  /** The step, or `null` for "pinned to nothing" — which is most media. */
  timelineItemId: string | null
}

/** Whether this is a kind of thing that belongs on a step at all. */
export function isPinnableToTimeline(type: string): boolean {
  return (TIMELINE_PINNABLE_TYPES as readonly string[]).includes(type)
}

/**
 * Everything on the event that COULD be pinned, in the order it arrived — what
 * the host's picker offers. A photo and a video are not here, and
 * `setMediaTimelineItem` (`server/domain/media.ts`) refuses one with a 422
 * against this same list, so the picker and the server cannot disagree about
 * what a step may carry.
 *
 * ALREADY-PINNED ITEMS ARE STILL IN IT, deliberately: an item pinned to the
 * 09:14 is a legitimate thing to move onto the 11:40, and a picker that hid it
 * would make moving a ticket a two-step un-pin-then-pin. The caller drops the
 * ones already on the step it is offering.
 */
export function pinnableToTimeline<T extends PinnableMedia>(items: readonly T[]): T[] {
  return items.filter(m => isPinnableToTimeline(m.type))
}

/**
 * The pinned media of a whole itinerary, keyed by step id — ONE GROUPING for
 * the whole list rather than a scan per step, because an itinerary renders
 * every step and a per-step scan is the N+1 shape one level up from the
 * database. (It walks the list three times, twice to order and once to group;
 * what it is not is once per step.)
 *
 * A STEP THAT HAS NOTHING PINNED HAS NO KEY, which is what makes "an itinerary
 * with no pinned media renders exactly as it does today" a property of this
 * function rather than a `v-if` somebody adds later: the caller asks for a step
 * and gets an empty array, and an empty array renders nothing.
 *
 * TICKETS COME BEFORE PAPERS on a step, whatever order the read gave. At the
 * step you are standing at, the thing that gets you through the barrier is the
 * thing you need first; the reservation is what you show afterwards. Within a
 * kind the read's own order is kept, which is the order the Tickets section
 * shows them in — two lists of the same files disagreeing about their order is
 * a screen you cannot check against itself.
 *
 * IT FILTERS ON THE TYPE TOO, and that is not redundancy with the server's
 * refusal. The column has accepted any media row since the transplant, so an
 * instance that pinned a photo before this issue existed — by a `/api/v1`
 * client, by hand, by a future widening — has rows this renderer has no lines
 * for. Dropping them here is the difference between a step that renders what it
 * can and a step with a download button and nothing to read.
 */
export function pinnedMediaByTimelineItem<T extends PinnableMedia>(items: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>()
  const ordered = [
    ...items.filter(m => m.type === 'ticket'),
    ...items.filter(m => m.type === 'document')
  ]
  for (const m of ordered) {
    if (!m.timelineItemId) continue
    const list = out.get(m.timelineItemId)
    if (list) list.push(m)
    else out.set(m.timelineItemId, [m])
  }
  return out
}

/* ------------------- what the invite link's itinerary renders ------------- */

/**
 * A pinned item as the guest itinerary draws it: the file, and for a ticket the
 * two things #35 and #37 put beside it — what it says, and whose it is.
 */
export interface PinnedMediaItem extends PinnableMedia {
  type: PinnableMediaType
  fileName: string
  caption: string | null
  /** The short-lived signed download (`signMediaItems`), never a stored URL. */
  url: string
  /**
   * Whether the viewer is one of this ticket's assignees — the SERVER's answer
   * (#37), and `false` for a shared document, which is not anybody's in
   * particular and never was.
   */
  mine: boolean
  /** Everybody this ticket is for, by name. Empty for a document. */
  assignedTo: Array<{ rsvpId: string, name: string }>
  /** What the ticket says (#35); absent for a document. */
  ticket?: TicketDetailFields | null
}

/** The shape of the invite link's media answer that this file reads. */
export interface GuestMediaBuckets {
  documents: Array<PinnableMedia & { fileName: string, caption: string | null, url: string }>
  tickets: Array<PinnableMedia & {
    fileName: string
    caption: string | null
    url: string
    mine: boolean
    assignedTo: Array<{ rsvpId: string, name: string }>
    ticket?: TicketDetailFields | null
  }>
}

/**
 * THE TWO BUCKETS BECOME ONE LIST, AND THE NORMALISATION HAPPENS HERE RATHER
 * THAN ON THE PAGE.
 *
 * `/api/invites/{token}/media` answers three arrays, and only tickets carry
 * `mine` and `assignedTo` — the widening in #37 is exactly tickets and the
 * documents deliberately did not get those fields. An itinerary step renders
 * both, so somebody has to give a document the honest empty, and the natural
 * place to write that is a `.map` on the page — where `mine: true` would be one
 * word, would type-check, and would label every reservation on the trip as the
 * viewer's own with nothing in this repository able to see it.
 *
 * So it is one call the page makes and one line a test can pin. `gallery` is
 * not read at all: a photo cannot be pinned (`TIMELINE_PINNABLE_TYPES`).
 */
export function timelinePinnedMedia(buckets: GuestMediaBuckets): PinnedMediaItem[] {
  return [
    ...buckets.tickets.map(t => ({ ...t, type: 'ticket' as const })),
    // A DOCUMENT IS NOBODY'S, and that is the honest value rather than a
    // placeholder: `listMediaForViewer` builds every document view with no
    // assignees at all, so there is no answer being withheld here.
    ...buckets.documents.map(d => ({ ...d, type: 'document' as const, mine: false, assignedTo: [] }))
  ]
}
