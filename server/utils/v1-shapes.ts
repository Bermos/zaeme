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

/** `components.schemas.Expense`. */
export function expense(row: object) {
  const r = asRow(row)
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    amountCents: r.amountCents,
    currency: r.currency,
    note: r.note ?? null,
    paidByName: r.paidByName,
    paidByEmail: r.paidByEmail,
    createdAt: r.createdAt,
    shares: r.shares ?? []
  }
}

/** `components.schemas.Budget` — integer cents throughout, no floats. */
export function budget(row: object) {
  const r = asRow(row)
  return {
    currency: r.currency,
    totalCents: r.totalCents ?? 0,
    expenses: ((r.expenses ?? []) as Row[]).map(expense),
    balances: r.balances ?? [],
    settlements: r.settlements ?? []
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
