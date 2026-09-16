/**
 * MINE OR EVERYBODY'S — the two buttons over the ticket list (#37).
 *
 * The server used to decide this: `/api/invites/{token}/media` took the
 * viewer's email and answered with the tickets matched to it, so four friends
 * at a barrier with one phone between them had one ticket and no way to reach
 * the other three. The owner's decision (#37, D2 revised) is that this is not a
 * permission boundary at all — "it's for friends, we do not need to segregate
 * during an event between members" — so the invite link now reaches every
 * ticket on the event and the email is a MARKER saying which of them are yours.
 *
 * ── WHY THE RULE IS A FUNCTION IN `shared/utils/` AND NOT FOUR LINES IN A CARD ──
 *
 * The same reason `ticketDetailLines` beside it is (#35, and `zonesToOffer`
 * before that): the ticket list is fetched by the BROWSER — media URLs are
 * short-lived signatures, so `app/pages/i/[token].vue` loads them `onMounted`
 * and no SSR'd HTML carries them. `pnpm smoke:api` can therefore prove the
 * server answers with every ticket and is structurally incapable of seeing the
 * card render the wrong subset of them, or render an empty box where a sentence
 * belongs. A check that watches the wire while the defect lives in the renderer
 * is a check that would have passed. So the decision lives here, where
 * `test/ticket-scope.test.ts` executes the real thing.
 *
 * ── THE EMPTY MINE IS THE POINT, NOT AN EDGE CASE ──
 *
 * Nobody has to say who they are to open an invite link, and most people
 * opening one for the first time have not. `Mine` is the default tab, so the
 * FIRST thing a new arrival sees is a list filtered by an identity they have
 * not given — which renders as nothing at all and reads as broken. An empty box
 * is the one outcome this feature must never produce, so the notice is computed
 * beside the filter rather than left to a `v-if` somebody adds later.
 */

/** Which of the two buttons is pressed. `mine` is the default. */
export type TicketScope = 'mine' | 'all'

/** The least a ticket has to carry for these two functions to do their job. */
export interface ScopedTicket {
  /**
   * Whether the viewer is one of this ticket's assignees — decided by the
   * SERVER (`listMediaForViewer`), because the browser does not know the
   * viewer's RSVP ids and a client that guessed from a name would get a pair
   * fare wrong. `false` for every ticket when nobody has said who they are, and
   * `false` for a ticket assigned to nobody.
   */
  mine: boolean
}

/**
 * The tickets one button shows. `all` is the whole list — including a ticket
 * assigned to NOBODY, which is a real state (a planner has uploaded the group
 * booking and not yet said who is on it) and belongs under `all` and nowhere
 * else: it is not anybody's, so it cannot be mine.
 */
export function ticketsInScope<T extends ScopedTicket>(tickets: readonly T[], scope: TicketScope): T[] {
  return scope === 'all' ? [...tickets] : tickets.filter(t => t.mine)
}

/** What the list knows about itself when it is deciding whether to explain. */
export interface TicketScopeCounts {
  /** Every ticket on the event — what `all` renders. */
  total: number
  /** How many of them are the viewer's. */
  mine: number
  /**
   * Whether the read carried an email at all. NOT "is this person who they say
   * they are": the `?email=` identity is asserted by the caller and always was
   * (#37 makes the consequence explicit and the owner has said yes to it). It
   * is the difference between "you have not told us" and "we looked and none of
   * these is yours", which are two different sentences to a person.
   */
  identified: boolean
}

/**
 * The sentence to put where the list would be, or `null` when there is a list
 * to render instead.
 *
 * THREE ANSWERS, NOT TWO, and the third is the one the issue is about: an
 * anonymous viewer on `Mine` is told how to be recognised, and a viewer we DO
 * know is told that nothing here is theirs and where the rest of them are.
 * Folding those together would give the person who has already typed their
 * address advice they have followed.
 */
export function ticketScopeNotice(scope: TicketScope, counts: TicketScopeCounts): string | null {
  if (scope === 'all') {
    return counts.total === 0 ? 'No tickets yet — your host adds them here.' : null
  }
  if (counts.mine > 0) return null
  if (!counts.identified) {
    return 'Tell us who you are — add your name and email above and the tickets bought for you show up here. '
      + 'Everything the group has is under All in the meantime.'
  }
  return counts.total === 0
    ? 'No tickets yet — your host adds them here.'
    : 'Nothing here is yours yet. Tap All to see everybody\'s — one phone at the barrier is enough.'
}
