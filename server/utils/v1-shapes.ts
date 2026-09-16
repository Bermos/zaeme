/**
 * Response shaping for the machine API.
 *
 * The domain returns whole table rows; the contract
 * (`docs/zaeme-api.openapi.yaml`, `components.schemas`) names a specific,
 * smaller set of fields per resource. These projections are that list, in one
 * place, so a column added to `events_event` tomorrow does not silently become
 * part of a generated MCP tool's result the day after — and so the handlers stay
 * three lines each.
 *
 * Dates are left as `Date`: Nitro serialises them to ISO 8601, which is what
 * `components.schemas.IsoDateTime` asks for.
 */

type Row = Record<string, unknown>

/**
 * Domain functions return typed rows and view interfaces, which TypeScript will
 * not widen to an index signature on their own. Every projection below takes a
 * plain `object` and reads it through this one cast, so the widening happens in
 * a single named place rather than at fourteen call sites.
 */
const asRow = (value: object): Row => value as Row

/** `components.schemas.EventSummary`. */
export function eventSummary(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    type: r.type,
    status: r.status,
    startsAt: r.startsAt ?? null,
    endsAt: r.endsAt ?? null,
    location: r.location ?? null,
    isPublic: r.isPublic ?? false,
    parentId: r.parentId ?? null,
    plannerRole: r.plannerRole ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

/** `components.schemas.EventDetail` — the summary plus the planning team. */
export function eventDetail(row: object) {
  const r = asRow(row)
  return {
    ...eventSummary(row),
    description: r.description ?? null,
    venueStation: r.venueStation ?? null,
    ticketUrl: r.ticketUrl ?? null,
    performerNote: r.performerNote ?? null,
    posterUrl: r.posterUrl ?? null,
    cadence: r.cadence ?? null,
    planners: ((r.planners ?? []) as Row[]).map(p => ({
      userId: p.userId ?? null,
      name: p.name ?? null,
      email: p.email ?? null,
      role: p.role
    }))
  }
}

/** `components.schemas.Showing` — an event summary plus its sign-up count. */
export function showing(row: object) {
  const r = asRow(row)
  return { ...eventSummary(row), signUpCount: r.signUpCount ?? 0 }
}

/** `components.schemas.Invite`. */
export function invite(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    token: r.token,
    label: r.label ?? null,
    email: r.email ?? null,
    name: r.name ?? null,
    tier: r.tier ?? null,
    maxUses: r.maxUses ?? null,
    usedCount: r.usedCount ?? 0,
    // Only `listInvites` computes this; a freshly minted link has none.
    rsvpCount: r.rsvpCount ?? 0,
    expiresAt: r.expiresAt ?? null,
    revokedAt: r.revokedAt ?? null,
    createdAt: r.createdAt
  }
}

/**
 * `components.schemas.Rsvp`. Note there is deliberately no `personId`: guest
 * identity is zäme's after the split, and re-adding one would quietly re-open
 * that seam.
 */
export function rsvp(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    status: r.status,
    plusOne: r.plusOne ?? false,
    plusOneName: r.plusOneName ?? null,
    dietary: r.dietary ?? null,
    accessibility: r.accessibility ?? null,
    notes: r.notes ?? null,
    guestName: r.guestName ?? null,
    guestEmail: r.guestEmail ?? null,
    inviteId: r.inviteId ?? null,
    inviteLabel: r.inviteLabel ?? null,
    createdAt: r.createdAt
  }
}

/** `components.schemas.TimelineItem`. */
export function timelineItem(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    startsAt: r.startsAt ?? null,
    endsAt: r.endsAt ?? null,
    location: r.location ?? null,
    type: r.type,
    sortOrder: r.sortOrder ?? 0,
    createdAt: r.createdAt
  }
}

/** `components.schemas.MediaItem` — metadata only, never a download URL. */
export function mediaItem(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    type: r.type,
    fileName: r.fileName ?? null,
    caption: r.caption ?? null,
    takenAt: r.takenAt ?? null,
    assignedRsvpId: r.assignedRsvpId ?? null,
    timelineItemId: r.timelineItemId ?? null,
    // The expense this item is the receipt for (#29). Additive, and an id
    // rather than a URL for the same reason as everything else here: the bytes
    // stay in zäme and are served to guests there.
    expenseId: r.expenseId ?? null,
    createdAt: r.createdAt
  }
}

/** `components.schemas.PollOption`. */
export function pollOption(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    startsAt: r.startsAt,
    endsAt: r.endsAt ?? null,
    note: r.note ?? null,
    votes: ((r.votes ?? []) as Row[]).map(v => ({
      name: v.name ?? null,
      email: v.email ?? null,
      answer: v.answer
    })),
    tally: r.tally ?? { yes: 0, ifneedbe: 0, no: 0 }
  }
}

/** `components.schemas.Contribution`. */
export function contribution(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    quantity: r.quantity ?? null,
    note: r.note ?? null,
    claimedByName: r.claimedByName ?? null,
    claimedByEmail: r.claimedByEmail ?? null,
    claimedAt: r.claimedAt ?? null
  }
}

/**
 * `components.schemas.Expense` — one JOURNAL ENTRY (#61).
 *
 * Two amounts, always: `amountCents` in the currency the money was actually
 * spent in, and `amountBaseCents` in THE EVENT'S currency (#59 — it was the
 * instance's until then, and the field keeps its name because Enterprise
 * generates a client from it), frozen at the `fxRate` this row was recorded at.
 * Only the base figures are ever summed; the as-spent ones are for showing
 * "€120.00 (CHF 112.40)".
 *
 * `fxRateSource` says where that rate came from. `manual` means a PERSON stated
 * it — the rate, or what their bank actually took off them — so it is the row
 * somebody checked against a statement, and a recomputation carries that figure
 * across rather than re-deriving it from the receipt. `fetched` means this
 * instance derived it: a lookup, an identity conversion, or a recompute after
 * the trip's currency changed.
 *
 * `statedAmountCents`/`statedCurrency` are that figure AS IT WAS STATED, kept
 * unchanged by every later recomputation while `amountBaseCents` is re-derived.
 * They are null on a `fetched` row. A client showing "checked against a
 * statement" should show these beside the settled figure when the two differ,
 * or it is attributing a chained conversion to a person.
 *
 * `fxRate` is 1 only when nothing was applied. It is NOT 1 merely because
 * `currency` equals `baseCurrency`: a stated figure survives a trip moving to
 * the currency its own receipt is in, which leaves the two codes equal and the
 * two amounts apart. Anything deciding "was this converted" must read `fxRate`.
 *
 * `splitMode`, and the `weight` on each share, say how the total was divided
 * (#26). Both are a record of intent — the shares are materialised, so a client
 * that ignores them gets every figure it got before they existed.
 *
 * `category` IS NO LONGER AN ENUM. It is the name of the category account the
 * cost was debited to, and `categoryAccountId` is that account. The old five
 * values still resolve on the way in (`food` finds `Food`, `other` finds
 * `Uncategorised`), so a client that writes them keeps working; what comes back
 * is the account's name, which a group can rename and add to.
 *
 * `lines` is the entry itself: every posting, credits included, summing to zero.
 * The residual line on the event's `Rounding` account — the cents between the
 * converted total and the sum of the converted shares — appears only there.
 */
export function expense(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    categoryAccountId: r.categoryAccountId ?? null,
    amountCents: r.amountCents,
    currency: r.currency,
    amountBaseCents: r.amountBaseCents,
    baseCurrency: r.baseCurrency,
    fxRate: r.fxRate,
    fxRateSource: r.fxRateSource,
    statedAmountCents: r.statedAmountCents ?? null,
    statedCurrency: r.statedCurrency ?? null,
    splitMode: r.splitMode,
    note: r.note ?? null,
    paidByName: r.paidByName,
    paidByEmail: r.paidByEmail,
    createdAt: r.createdAt,
    shares: r.shares ?? [],
    lines: ((r.lines ?? []) as Row[]).map(l => ({
      accountId: l.accountId,
      accountName: l.accountName,
      accountKind: l.accountKind,
      accountEmail: l.accountEmail ?? null,
      amountCents: l.amountCents,
      amountBaseCents: l.amountBaseCents
    }))
  }
}

/**
 * `components.schemas.Budget` — integer cents throughout, no floats.
 *
 * `currency` is THE EVENT'S CURRENCY, and `totalCents`, every balance and every
 * settlement are in it. It was the first expense row's currency until #25 made
 * it the instance's, and #59 moved it to the trip — which is where the answer
 * differs, and where somebody can change it.
 *
 * `approximate` is true when anything here went through a conversion, or when a
 * currency change left cents on `Rounding`. It is a statement of fact for the
 * screen to render once, the way a card receipt says "rate at time of
 * purchase": converted at the rate recorded with each entry, so the totals are
 * close rather than exact.
 *
 * `accounts` is the event's chart of accounts with what has been posted to each
 * (#61): members carry a balance, categories carry what was spent on them in
 * `debitCents`, and the one `rounding` account carries the conversion residual.
 * `totalCents` is the sum of category debits — a member-to-member transfer
 * touches no category account and is therefore excluded structurally, with no
 * flag to set.
 */
export function budget(row: object) {
  const r = asRow(row)
  return {
    currency: r.currency,
    approximate: r.approximate ?? false,
    totalCents: r.totalCents ?? 0,
    expenses: ((r.expenses ?? []) as Row[]).map(expense),
    balances: r.balances ?? [],
    settlements: r.settlements ?? [],
    accounts: ((r.accounts ?? []) as Row[]).map(a => ({
      id: a.id,
      kind: a.kind,
      name: a.name,
      email: a.email ?? null,
      isSystem: a.isSystem ?? false,
      debitCents: a.debitCents ?? 0,
      creditCents: a.creditCents ?? 0,
      netCents: a.netCents ?? 0,
      lineCount: a.lineCount ?? 0
    }))
  }
}

/** `components.schemas.SeriesMember`. */
export function seriesMember(row: object) {
  const r = asRow(row)
  return { id: r.id, name: r.name, email: r.email, createdAt: r.createdAt }
}

/** `components.schemas.ChatMessage`. */
export function chatMessage(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    body: r.body,
    authorName: r.authorName ?? null,
    authorEmail: r.authorEmail ?? null,
    isHost: r.isHost ?? false,
    createdAt: r.createdAt
  }
}

/** `components.schemas.PlannerInvite` — the link is assembled, not derived twice. */
export function plannerInvite(row: object, url: string) {
  const r = asRow(row)
  return {
    id: r.id,
    token: r.token,
    url,
    email: r.email ?? null,
    role: r.role,
    expiresAt: r.expiresAt ?? null
  }
}

/** The `{ removed: true }` body every DELETE in the contract answers. */
export const REMOVED = { removed: true } as const
