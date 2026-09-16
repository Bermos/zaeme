import { formatInZone } from './timezone'

/**
 * WHAT A TICKET SAYS, AS THE LINES A PERSON READS AT A BARRIER (#35).
 *
 * A ticket is a PDF, and a PDF is the wrong shape for the thirty seconds in
 * which somebody has to say "coach 12, seat 41A" to a conductor — it has to
 * download, it has to render, and on a train through a tunnel it does neither.
 * So the facts are rows (`events_ticket_detail`) and this is the one place that
 * turns them into text.
 *
 * ── WHY THIS IS A FUNCTION IN `shared/utils/` AND NOT THREE LINES IN A CARD ──
 *
 * The same reason `zonesToOffer` is (#31 review, and the precedent
 * `settlement.ts` and `split-weight.ts` set): the ticket list is rendered by a
 * CLIENT-SIDE fetch — media URLs are short-lived signatures, so
 * `app/pages/i/[token].vue` loads them `onMounted` and they are not in the
 * SSR'd HTML at all. That means `pnpm smoke:api` can prove the server answers
 * with `"seat":"41A"` and is structurally incapable of seeing the card render
 * it in the wrong clock, or not render it. A check that watches the wire while
 * the defect lives in the renderer is a check that would have passed — which is
 * exactly how #31 shipped every stored instant formatted against the reader's
 * clock with zero red tests. So the decision lives here, where
 * `test/ticket-detail.test.ts` executes the real thing.
 *
 * ── THE CLOCK ──
 *
 * `validFrom`/`validUntil` are instants (`timestamptz`), and they are rendered
 * against the EVENT's zone (#31), not the reader's. A ticket valid "until
 * 23:59" means 23:59 where the barrier is: a friend checking their Lisbon
 * ticket from Zürich must not be shown 00:59 on the following day, which is a
 * missed train dressed up as a rendering.
 *
 * AND THE LINE NAMES THE CLOCK IT IS IN, per instant (`timeZoneName: 'short'`)
 * rather than through the `zoneNote` heading the itinerary cards use. Two
 * reasons, and the first is the deciding one: a ticket is read ALONE, held up
 * at a gate, with nothing else from the page in view, so a heading four cards
 * away is not a label. The second is that `zoneNote` deliberately names the
 * zone and not the abbreviation, because `WEST` is true of an instant and not
 * of a week — while a ticket's validity IS an instant, so the abbreviation is
 * exactly right for it and wrong for the itinerary above it.
 *
 * With no event zone the stamp is the reader's own, which is the honest answer:
 * a null zone means "the viewer's clock" everywhere else in this app too.
 */

/** A detail as it survives JSON: instants as strings, everything nullable. */
export interface TicketDetailFields {
  bookingRef?: string | null
  carrier?: string | null
  seat?: string | null
  coach?: string | null
  travellerName?: string | null
  validFrom?: string | Date | null
  validUntil?: string | Date | null
  note?: string | null
}

function clean(v: string | null | undefined): string | null {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * The seat line — "coach 12, seat 41A", "seat 41A", "coach 12", or nothing.
 *
 * Its own function because it is the phrase the issue is named after and the
 * one a conductor asks for, and because the three-way join is the part that is
 * easy to get wrong in a template (`coach 12, seat` with a trailing comma when
 * only one of the two is filled in — which is the ordinary case for a bus).
 */
export function seatLine(detail: TicketDetailFields | null | undefined): string | null {
  if (!detail) return null
  const coach = clean(detail.coach)
  const seat = clean(detail.seat)
  const parts: string[] = []
  if (coach) parts.push(`coach ${coach}`)
  if (seat) parts.push(`seat ${seat}`)
  return parts.length ? parts.join(', ') : null
}

/** How a single validity instant is stamped: the date, the time, and the clock. */
const VALID_AT: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short'
}

/**
 * The validity line, in the event's zone — "Valid Wed, 1 Jul, 09:00 WEST until
 * Wed, 1 Jul, 23:59 WEST", or one half of it, or nothing.
 *
 * Both halves carry their own stamp rather than one at the end, because the two
 * instants need not be in the same offset: a ticket valid across the last
 * Sunday in October is half WEST and half WET, and one trailing abbreviation
 * would be wrong for one of its own ends.
 */
export function validityLine(
  detail: TicketDetailFields | null | undefined,
  zone: string | null | undefined
): string | null {
  if (!detail) return null
  const from = formatInZone(detail.validFrom ?? null, VALID_AT, zone)
  const until = formatInZone(detail.validUntil ?? null, VALID_AT, zone)
  if (from && until) return `Valid ${from} until ${until}`
  if (from) return `Valid from ${from}`
  if (until) return `Valid until ${until}`
  return null
}

/**
 * Everything worth reading about a ticket, in the order somebody reads it, as
 * plain strings a card renders one per line.
 *
 * EMPTY IS A LEGITIMATE ANSWER AND THE COMMON ONE. A ticket with no detail row
 * (`null`) and a ticket whose detail row is entirely blank return the same
 * `[]`, which is the whole of what makes this feature optional: the card that
 * renders these shows the download exactly as it did before #35 when the list
 * is empty, so nothing about uploading a PDF ever starts asking to be filled
 * in.
 */
export function ticketDetailLines(
  detail: TicketDetailFields | null | undefined,
  zone: string | null | undefined
): string[] {
  if (!detail) return []
  const carrier = clean(detail.carrier)
  const ref = clean(detail.bookingRef)
  const lines: string[] = []
  // The carrier and the reference are one line: they are read together at a
  // counter ("SBB, booking XY7Q2M") and neither is much use alone.
  if (carrier && ref) lines.push(`${carrier} · ${ref}`)
  else if (carrier) lines.push(carrier)
  else if (ref) lines.push(`Booking ${ref}`)

  const seat = seatLine(detail)
  if (seat) lines.push(seat)

  const traveller = clean(detail.travellerName)
  if (traveller) lines.push(traveller)

  const validity = validityLine(detail, zone)
  if (validity) lines.push(validity)

  const note = clean(detail.note)
  if (note) lines.push(note)

  return lines
}
