import { and, asc, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { guestSession, guestUser } from '../database/schema/auth'

/**
 * The CROSS-EVENT domain: everything the owner could only see inside Enterprise
 * because it could query the whole table at once, plus the reads the instance
 * administration surface needs.
 *
 * Two rules shape every function here.
 *
 * **1. Instance scope, not planner scope.** The rest of `server/domain` is
 * user-scoped: `listEvents(userId)` joins through `events_event_planner`, and
 * `assertPlanner` guards every write. These functions are not scoped, on
 * purpose — they answer questions about the INSTANCE ("every invite that
 * exists", "which of these accounts is real"), and the only caller allowed to
 * ask them is the instance owner. That gate lives in `server/utils/admin.ts`
 * and is applied by every `/api/admin` route; nothing here re-checks it,
 * exactly as nothing in `events-data.ts` re-checks the session.
 *
 * **2. No N+1, ever.** These are the views with actual volume — every event,
 * every invite, every person who ever answered anything. A per-row follow-up
 * query here is the difference between one round trip and four hundred, so
 * counts arrive as scalar sub-selects or grouped aggregates in the SAME
 * statement, and a list never triggers a query per item.
 */

/**
 * ⚠️ CORRELATED SUB-SELECTS ARE WRITTEN WITH THE OUTER COLUMN SPELLED OUT
 * (`events_event.id`, not `${tables.event.id}`).
 *
 * Drizzle renders an interpolated column UNQUALIFIED inside a `sql` template —
 * `${tables.event.id}` becomes `"id"` — and Postgres then resolves that name
 * against the INNERMOST table that happens to have it. `where r.event_id = "id"`
 * silently means `r.event_id = r.id`, which is never true, so the count comes
 * back 0 for every row and nothing errors. (`listInvites` in events-data.ts had
 * exactly this bug: every invite reported 0 responses.) Spelling the outer table
 * out is unambiguous, and the tables are never aliased in these queries.
 */

/* --------------------------------- overview -------------------------------- */

export interface InstanceOverview {
  events: { total: number, draft: number, polling: number, published: number, completed: number, cancelled: number, upcoming: number, series: number }
  people: { guests: number, accounts: number, seriesMembers: number }
  invites: { total: number, active: number, revoked: number }
  media: { items: number, bytes: number, pending: number }
  next: Array<{ slug: string, title: string, status: string, type: string, startsAt: string | null, yesCount: number }>
  needsAttention: Array<{ slug: string, title: string, reason: string, startsAt: string | null }>
}

/**
 * The whole landing page in ONE statement. Every count is a scalar sub-select,
 * so Postgres plans it once; the two lists come back pre-serialised as JSON
 * rather than as rows fanned out against the counts.
 */
export async function instanceOverview(): Promise<InstanceOverview> {
  const result = await useDb().execute(sql`
    select
      (select count(*)::int from events_event) as events_total,
      (select count(*)::int from events_event where status = 'draft') as events_draft,
      (select count(*)::int from events_event where status = 'polling') as events_polling,
      (select count(*)::int from events_event where status = 'published') as events_published,
      (select count(*)::int from events_event where status = 'completed') as events_completed,
      (select count(*)::int from events_event where status = 'cancelled') as events_cancelled,
      (select count(*)::int from events_event where type = 'series') as events_series,
      (select count(*)::int from events_event
        where starts_at is not null and starts_at >= now() and status not in ('cancelled', 'completed')) as events_upcoming,
      (select count(distinct lower(guest_email))::int from events_rsvp where guest_email is not null) as guests,
      (select count(*)::int from zaeme_user) as accounts,
      (select count(distinct lower(email))::int from events_series_member) as series_members,
      (select count(*)::int from events_invite) as invites_total,
      (select count(*)::int from events_invite where revoked_at is null) as invites_active,
      (select count(*)::int from events_invite where revoked_at is not null) as invites_revoked,
      (select count(*)::int from events_media where status = 'ready') as media_items,
      (select coalesce(sum(size_bytes), 0)::bigint from events_media where status = 'ready') as media_bytes,
      (select count(*)::int from events_media where status = 'pending') as media_pending,
      (
        select coalesce(json_agg(n order by n.starts_at), '[]'::json) from (
          select e.slug, e.title, e.status, e.type, e.starts_at,
                 (select count(*)::int from events_rsvp r where r.event_id = e.id and r.status in ('yes', 'cheering')) as yes_count
          from events_event e
          where e.starts_at is not null and e.starts_at >= now() and e.status not in ('cancelled', 'completed')
          order by e.starts_at
          limit 5
        ) n
      ) as next,
      (
        select coalesce(json_agg(a), '[]'::json) from (
          -- A dated draft that never got published, and a poll nobody voted in:
          -- the two ways a gathering quietly fails to happen.
          select e.slug, e.title, e.starts_at, 'still a draft, and the date is close' as reason
          from events_event e
          where e.status = 'draft' and e.starts_at is not null
            and e.starts_at between now() and now() + interval '21 days'
          union all
          select e.slug, e.title, e.starts_at, 'polling, but nobody has voted' as reason
          from events_event e
          where e.status = 'polling'
            and exists (select 1 from events_date_option o where o.event_id = e.id)
            and not exists (select 1 from events_date_vote v where v.event_id = e.id)
          union all
          select e.slug, e.title, e.starts_at, 'published with no responses yet' as reason
          from events_event e
          where e.status = 'published' and e.starts_at is not null
            and e.starts_at between now() and now() + interval '14 days'
            and not exists (select 1 from events_rsvp r where r.event_id = e.id)
        ) a
      ) as attention
  `)

  const raw = (result.rows[0] ?? {}) as Record<string, unknown>
  const num = (v: unknown) => Number(v ?? 0)
  const list = <T>(v: unknown) => (v ?? []) as T[]

  return {
    events: {
      total: num(raw.events_total),
      draft: num(raw.events_draft),
      polling: num(raw.events_polling),
      published: num(raw.events_published),
      completed: num(raw.events_completed),
      cancelled: num(raw.events_cancelled),
      upcoming: num(raw.events_upcoming),
      series: num(raw.events_series)
    },
    people: { guests: num(raw.guests), accounts: num(raw.accounts), seriesMembers: num(raw.series_members) },
    invites: { total: num(raw.invites_total), active: num(raw.invites_active), revoked: num(raw.invites_revoked) },
    media: { items: num(raw.media_items), bytes: num(raw.media_bytes), pending: num(raw.media_pending) },
    next: list<{ slug: string, title: string, status: string, type: string, starts_at: string | null, yes_count: number }>(raw.next)
      .map(n => ({ slug: n.slug, title: n.title, status: n.status, type: n.type, startsAt: n.starts_at, yesCount: Number(n.yes_count ?? 0) })),
    needsAttention: list<{ slug: string, title: string, starts_at: string | null, reason: string }>(raw.attention)
      .map(a => ({ slug: a.slug, title: a.title, startsAt: a.starts_at, reason: a.reason }))
  }
}

/* ------------------------------- every event ------------------------------- */

export interface AdminEventFilter {
  status?: string
  type?: string
  /** Free text over title, slug and location. */
  q?: string
  /** `upcoming` | `past` | `undated` — the three ways a date can matter. */
  when?: 'upcoming' | 'past' | 'undated'
  limit?: number
  offset?: number
}

/**
 * Every event on the instance, with its counts — the view Enterprise could
 * build only because it could see the whole table.
 *
 * The four counts are correlated sub-selects rather than four joins: joining
 * rsvps, invites, media and timeline items at once multiplies the rows before
 * it aggregates them, and the fix for that (four grouped CTEs) costs more than
 * it saves at this size. Either way it is ONE statement, not one per row.
 */
export async function listAllEvents(filter: AdminEventFilter = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)
  const e = tables.event

  const where = [
    filter.status ? eq(e.status, filter.status as typeof e.$inferSelect.status) : undefined,
    filter.type ? eq(e.type, filter.type as typeof e.$inferSelect.type) : undefined,
    filter.q
      ? or(
          sql`${e.title} ilike ${'%' + filter.q + '%'}`,
          sql`${e.slug} ilike ${'%' + filter.q + '%'}`,
          sql`coalesce(${e.location}, '') ilike ${'%' + filter.q + '%'}`
        )
      : undefined,
    filter.when === 'upcoming' ? sql`${e.startsAt} is not null and ${e.startsAt} >= now()` : undefined,
    filter.when === 'past' ? sql`${e.startsAt} is not null and ${e.startsAt} < now()` : undefined,
    filter.when === 'undated' ? isNull(e.startsAt) : undefined
  ].filter(Boolean)

  const rows = await useDb()
    .select({
      id: e.id,
      slug: e.slug,
      title: e.title,
      type: e.type,
      status: e.status,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      location: e.location,
      isPublic: e.isPublic,
      parentId: e.parentId,
      externalRef: e.externalRef,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      parentTitle: sql<string | null>`(select p.title from events_event p where p.id = events_event.parent_id)`,
      yesCount: sql<number>`(select count(*)::int from events_rsvp r where r.event_id = events_event.id and r.status in ('yes', 'cheering'))`,
      rsvpCount: sql<number>`(select count(*)::int from events_rsvp r where r.event_id = events_event.id)`,
      inviteCount: sql<number>`(select count(*)::int from events_invite i where i.event_id = events_event.id and i.revoked_at is null)`,
      mediaCount: sql<number>`(select count(*)::int from events_media m where m.event_id = events_event.id and m.status = 'ready')`,
      plannerCount: sql<number>`(select count(*)::int from events_event_planner p where p.event_id = events_event.id)`
    })
    .from(e)
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${e.startsAt} desc nulls last`, desc(e.createdAt))
    .limit(limit)
    .offset(offset)

  const [totals] = await useDb()
    .select({ total: count() })
    .from(e)
    .where(where.length ? and(...where) : undefined)

  return { events: rows, total: totals?.total ?? 0, limit, offset }
}

/* ------------------------------ series overview ---------------------------- */

/**
 * Every series and its occurrences, in TWO statements regardless of how many
 * series there are: the containers with their member counts, then all children
 * of all series at once, grouped in memory.
 */
export async function seriesOverview() {
  const db = useDb()
  const e = tables.event

  const containers = await db
    .select({
      id: e.id,
      slug: e.slug,
      title: e.title,
      status: e.status,
      cadence: e.cadence,
      isPublic: e.isPublic,
      createdAt: e.createdAt,
      memberCount: sql<number>`(select count(*)::int from events_series_member m where m.series_id = events_event.id)`
    })
    .from(e)
    .where(eq(e.type, 'series'))
    .orderBy(asc(e.title))

  if (containers.length === 0) return []

  const occurrences = await db
    .select({
      id: e.id,
      parentId: e.parentId,
      slug: e.slug,
      title: e.title,
      status: e.status,
      startsAt: e.startsAt,
      posterUrl: e.posterUrl,
      yesCount: sql<number>`(select count(*)::int from events_rsvp r where r.event_id = events_event.id and r.status in ('yes', 'cheering'))`
    })
    .from(e)
    .where(inArray(e.parentId, containers.map(c => c.id)))
    .orderBy(desc(e.startsAt))

  const byParent = new Map<string, typeof occurrences>()
  for (const occ of occurrences) {
    if (!occ.parentId) continue
    const list = byParent.get(occ.parentId) ?? []
    list.push(occ)
    byParent.set(occ.parentId, list)
  }

  const now = Date.now()
  return containers.map((c) => {
    const list = byParent.get(c.id) ?? []
    const upcoming = [...list].reverse().find(o => o.startsAt && new Date(o.startsAt).getTime() >= now && o.status !== 'cancelled')
    return { ...c, occurrences: list, occurrenceCount: list.length, next: upcoming ?? null }
  })
}

/* --------------------------------- calendar -------------------------------- */

/** Every dated event in a window — the calendar across events, one statement. */
export async function calendarWindow(from: Date, to: Date) {
  const e = tables.event
  return useDb()
    .select({
      id: e.id,
      slug: e.slug,
      title: e.title,
      type: e.type,
      status: e.status,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      location: e.location,
      isPublic: e.isPublic,
      yesCount: sql<number>`(select count(*)::int from events_rsvp r where r.event_id = events_event.id and r.status in ('yes', 'cheering'))`
    })
    .from(e)
    .where(and(gte(e.startsAt, from), lte(e.startsAt, to)))
    .orderBy(asc(e.startsAt))
}

/* ------------------------------- media library ----------------------------- */

export interface MediaFilter {
  type?: 'photo' | 'video' | 'document' | 'ticket'
  eventSlug?: string
  limit?: number
  offset?: number
}

/** Ready media across every event, newest first, with the event it belongs to. */
export async function mediaLibrary(filter: MediaFilter = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 60, 1), 200)
  const offset = Math.max(filter.offset ?? 0, 0)
  const m = tables.media
  const e = tables.event

  const where = [
    eq(m.status, 'ready'),
    filter.type ? eq(m.type, filter.type) : undefined,
    filter.eventSlug ? eq(e.slug, filter.eventSlug) : undefined
  ].filter(Boolean)

  const items = await useDb()
    .select({
      id: m.id,
      type: m.type,
      storageKey: m.storageKey,
      mimeType: m.mimeType,
      fileName: m.fileName,
      caption: m.caption,
      sizeBytes: m.sizeBytes,
      takenAt: m.takenAt,
      createdAt: m.createdAt,
      assignedRsvpId: m.assignedRsvpId,
      eventSlug: e.slug,
      eventTitle: e.title
    })
    .from(m)
    .innerJoin(e, eq(m.eventId, e.id))
    .where(and(...where))
    .orderBy(desc(m.createdAt))
    .limit(limit)
    .offset(offset)

  const [totals] = await useDb()
    .select({ total: count(), bytes: sql<number>`coalesce(sum(${m.sizeBytes}), 0)::bigint` })
    .from(m)
    .innerJoin(e, eq(m.eventId, e.id))
    .where(and(...where))

  return { items, total: Number(totals?.total ?? 0), bytes: Number(totals?.bytes ?? 0), limit, offset }
}

/**
 * What this instance is storing. Media rows are the whole of it that zäme
 * KNOWS about: uploaded concert posters (`posters/<digest>`) are written
 * straight to the object store with no row to count, which is the same gap
 * issue #13 files under "nothing collects them".
 */
export async function storageUsage() {
  const db = useDb()
  const m = tables.media

  const [byType, topEvents, [pending]] = await Promise.all([
    db
      .select({
        type: m.type,
        items: count(),
        bytes: sql<number>`coalesce(sum(${m.sizeBytes}), 0)::bigint`
      })
      .from(m)
      .where(eq(m.status, 'ready'))
      .groupBy(m.type),
    db
      .select({
        slug: tables.event.slug,
        title: tables.event.title,
        items: count(),
        bytes: sql<number>`coalesce(sum(${m.sizeBytes}), 0)::bigint`
      })
      .from(m)
      .innerJoin(tables.event, eq(m.eventId, tables.event.id))
      .where(eq(m.status, 'ready'))
      .groupBy(tables.event.slug, tables.event.title)
      .orderBy(sql`sum(${m.sizeBytes}) desc`)
      .limit(10),
    db
      .select({
        items: count(),
        bytes: sql<number>`coalesce(sum(${m.sizeBytes}), 0)::bigint`
      })
      .from(m)
      .where(eq(m.status, 'pending'))
  ])

  return {
    byType: byType.map(r => ({ ...r, bytes: Number(r.bytes) })),
    topEvents: topEvents.map(r => ({ ...r, bytes: Number(r.bytes) })),
    /** Registered but never confirmed — an upload that died halfway. */
    pending: { items: pending?.items ?? 0, bytes: Number(pending?.bytes ?? 0) },
    total: byType.reduce((sum, r) => sum + Number(r.bytes), 0)
  }
}

/* ------------------------------ people directory --------------------------- */

export interface DirectoryPerson {
  email: string
  name: string | null
  hasAccount: boolean
  isOwner: boolean
  rsvpCount: number
  yesCount: number
  inviteCount: number
  activeInvites: number
  seriesCount: number
  messageCount: number
  lastSeen: string | null
  events: Array<{ slug: string, title: string, status: string }>
}

/**
 * Everybody this instance knows, keyed by the lowercased email that IS the
 * guest identity everywhere in the domain (schema/events.ts).
 *
 * One statement, and it has to be: a person is assembled from five different
 * tables, and doing that per person would be five queries times however many
 * friends the owner has. Each source is aggregated to one row per email first,
 * then the sources are outer-joined on the union of their emails.
 */
export async function peopleDirectory(opts: { q?: string, limit?: number } = {}): Promise<DirectoryPerson[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500)
  const q = opts.q ? `%${opts.q}%` : null

  const result = await useDb().execute(sql`
    with rsvped as (
      select lower(guest_email) as email,
             max(guest_name) as name,
             count(*)::int as rsvp_count,
             count(*) filter (where status in ('yes', 'cheering'))::int as yes_count,
             max(created_at) as last_rsvp
      from events_rsvp where guest_email is not null group by 1
    ),
    invited as (
      select lower(email) as email,
             max(name) as name,
             count(*)::int as invite_count,
             count(*) filter (where revoked_at is null)::int as active_invites,
             max(created_at) as last_invite
      from events_invite where email is not null group by 1
    ),
    membered as (
      select lower(email) as email, max(name) as name, count(*)::int as series_count
      from events_series_member group by 1
    ),
    messaged as (
      select lower(author_email) as email, max(author_name) as name,
             count(*)::int as message_count, max(created_at) as last_message
      from events_message group by 1
    ),
    everyone as (
      select email from rsvped
      union select email from invited
      union select email from membered
      union select email from messaged
      union select lower(email) from zaeme_user
    ),
    owner as (select id from zaeme_user order by created_at asc limit 1)
    select
      p.email,
      coalesce(u.name, r.name, i.name, m.name, g.name) as name,
      (u.id is not null) as has_account,
      (u.id is not null and u.id = (select id from owner)) as is_owner,
      coalesce(r.rsvp_count, 0) as rsvp_count,
      coalesce(r.yes_count, 0) as yes_count,
      coalesce(i.invite_count, 0) as invite_count,
      coalesce(i.active_invites, 0) as active_invites,
      coalesce(m.series_count, 0) as series_count,
      coalesce(g.message_count, 0) as message_count,
      greatest(r.last_rsvp, i.last_invite, g.last_message) as last_seen,
      (
        select coalesce(json_agg(x), '[]'::json) from (
          select e.slug, e.title, e.status
          from events_rsvp rr join events_event e on e.id = rr.event_id
          where lower(rr.guest_email) = p.email
          order by e.starts_at desc nulls last
          limit 5
        ) x
      ) as events
    from everyone p
    left join rsvped r on r.email = p.email
    left join invited i on i.email = p.email
    left join membered m on m.email = p.email
    left join messaged g on g.email = p.email
    left join zaeme_user u on lower(u.email) = p.email
    where ${q ? sql`(p.email ilike ${q} or coalesce(u.name, r.name, i.name, m.name, g.name) ilike ${q})` : sql`true`}
    order by last_seen desc nulls last, p.email
    limit ${limit}
  `)

  return (result.rows as Array<Record<string, unknown>>).map(row => ({
    email: String(row.email),
    name: (row.name as string | null) ?? null,
    hasAccount: Boolean(row.has_account),
    isOwner: Boolean(row.is_owner),
    rsvpCount: Number(row.rsvp_count ?? 0),
    yesCount: Number(row.yes_count ?? 0),
    inviteCount: Number(row.invite_count ?? 0),
    activeInvites: Number(row.active_invites ?? 0),
    seriesCount: Number(row.series_count ?? 0),
    messageCount: Number(row.message_count ?? 0),
    lastSeen: row.last_seen ? new Date(row.last_seen as string).toISOString() : null,
    events: ((row.events ?? []) as Array<{ slug: string, title: string, status: string }>)
  }))
}

/** One person in full — their answers, their links and their memberships. */
export async function personDetail(email: string) {
  const normalized = email.toLowerCase()
  const db = useDb()

  const [rsvps, invites, memberships, [account]] = await Promise.all([
    db
      .select({
        id: tables.rsvp.id,
        status: tables.rsvp.status,
        plusOne: tables.rsvp.plusOne,
        dietary: tables.rsvp.dietary,
        notes: tables.rsvp.notes,
        createdAt: tables.rsvp.createdAt,
        eventSlug: tables.event.slug,
        eventTitle: tables.event.title,
        eventStatus: tables.event.status,
        startsAt: tables.event.startsAt
      })
      .from(tables.rsvp)
      .innerJoin(tables.event, eq(tables.rsvp.eventId, tables.event.id))
      .where(eq(tables.rsvp.guestEmail, normalized))
      .orderBy(sql`${tables.event.startsAt} desc nulls last`),
    db
      .select({
        id: tables.invite.id,
        token: tables.invite.token,
        label: tables.invite.label,
        tier: tables.invite.tier,
        usedCount: tables.invite.usedCount,
        maxUses: tables.invite.maxUses,
        revokedAt: tables.invite.revokedAt,
        expiresAt: tables.invite.expiresAt,
        createdAt: tables.invite.createdAt,
        eventSlug: tables.event.slug,
        eventTitle: tables.event.title
      })
      .from(tables.invite)
      .innerJoin(tables.event, eq(tables.invite.eventId, tables.event.id))
      .where(eq(tables.invite.email, normalized))
      .orderBy(desc(tables.invite.createdAt)),
    db
      .select({
        id: tables.seriesMember.id,
        seriesSlug: tables.event.slug,
        seriesTitle: tables.event.title,
        createdAt: tables.seriesMember.createdAt
      })
      .from(tables.seriesMember)
      .innerJoin(tables.event, eq(tables.seriesMember.seriesId, tables.event.id))
      .where(eq(tables.seriesMember.email, normalized)),
    db
      .select({ id: guestUser.id, name: guestUser.name, email: guestUser.email, createdAt: guestUser.createdAt })
      .from(guestUser)
      .where(sql`lower(${guestUser.email}) = ${normalized}`)
      .limit(1)
  ])

  return { email: normalized, account: account ?? null, rsvps, invites, memberships }
}

/* --------------------------- invites, instance-wide ------------------------ */

export interface AdminInviteFilter {
  state?: 'active' | 'revoked' | 'expired'
  q?: string
  eventSlug?: string
  limit?: number
}

/** Every capability link on the instance, with the event it opens. */
export async function listAllInvites(filter: AdminInviteFilter = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500)
  const i = tables.invite
  const e = tables.event

  const where = [
    filter.state === 'active' ? sql`${i.revokedAt} is null and (${i.expiresAt} is null or ${i.expiresAt} > now())` : undefined,
    filter.state === 'revoked' ? sql`${i.revokedAt} is not null` : undefined,
    filter.state === 'expired' ? sql`${i.revokedAt} is null and ${i.expiresAt} is not null and ${i.expiresAt} <= now()` : undefined,
    filter.eventSlug ? eq(e.slug, filter.eventSlug) : undefined,
    filter.q
      ? or(
          sql`coalesce(${i.label}, '') ilike ${'%' + filter.q + '%'}`,
          sql`coalesce(${i.name}, '') ilike ${'%' + filter.q + '%'}`,
          sql`coalesce(${i.email}, '') ilike ${'%' + filter.q + '%'}`,
          sql`${e.title} ilike ${'%' + filter.q + '%'}`
        )
      : undefined
  ].filter(Boolean)

  return useDb()
    .select({
      id: i.id,
      token: i.token,
      label: i.label,
      name: i.name,
      email: i.email,
      tier: i.tier,
      maxUses: i.maxUses,
      usedCount: i.usedCount,
      expiresAt: i.expiresAt,
      revokedAt: i.revokedAt,
      createdAt: i.createdAt,
      createdByUserId: i.createdByUserId,
      eventSlug: e.slug,
      eventTitle: e.title,
      eventStatus: e.status,
      rsvpCount: sql<number>`(select count(*)::int from events_rsvp r where r.invite_id = events_invite.id)`
    })
    .from(i)
    .innerJoin(e, eq(i.eventId, e.id))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(i.createdAt))
    .limit(limit)
}

/**
 * Revoke any invite on the instance, by id alone.
 *
 * `revokeInvite` in `events-data.ts` needs the event slug and asserts the
 * caller plans that event — right for the host surface, wrong here: the owner
 * administering the instance is not necessarily a planner of the event whose
 * link has leaked, and "I can see it but not close it" is not an admin surface.
 * The authorisation is the owner gate, applied by the route.
 */
export async function revokeInviteAsOwner(inviteId: string) {
  const [updated] = await useDb()
    .update(tables.invite)
    .set({ revokedAt: new Date() })
    .where(eq(tables.invite.id, inviteId))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Invite not found' })
  return updated
}

/** Un-revoke — the undo for a mis-click, since revocation is otherwise final. */
export async function restoreInviteAsOwner(inviteId: string) {
  const [updated] = await useDb()
    .update(tables.invite)
    .set({ revokedAt: null })
    .where(eq(tables.invite.id, inviteId))
    .returning()
  if (!updated) throw createError({ statusCode: 404, message: 'Invite not found' })
  return updated
}

/* --------------------------------- accounts -------------------------------- */

/** The accounts on this instance, with what each one actually does here. */
export async function listAccounts(ownerId: string | null) {
  const u = guestUser
  const rows = await useDb()
    .select({
      id: u.id,
      name: u.name,
      email: u.email,
      emailVerified: u.emailVerified,
      createdAt: u.createdAt,
      plannerOf: sql<number>`(select count(*)::int from events_event_planner p where p.user_id = zaeme_user.id)`,
      activeSessions: sql<number>`(select count(*)::int from zaeme_session s where s.user_id = zaeme_user.id and s.expires_at > now())`,
      rsvpCount: sql<number>`(select count(*)::int from events_rsvp r where lower(r.guest_email) = lower(zaeme_user.email))`
    })
    .from(u)
    .orderBy(asc(u.createdAt))

  return rows.map(r => ({ ...r, isOwner: r.id === ownerId }))
}

/** Sign an account out everywhere. The owner's blunt instrument for a lost laptop. */
export async function revokeSessions(userId: string): Promise<number> {
  const removed = await useDb().delete(guestSession).where(eq(guestSession.userId, userId)).returning({ id: guestSession.id })
  return removed.length
}

/**
 * Delete an account.
 *
 * Never the owner's: the instance is defined by its first account
 * (`resolveInstanceOwnerId`), and deleting it would leave a running instance
 * whose owner is whoever signed up next.
 *
 * What survives on purpose: the person's RSVPs, messages and claims. Guest
 * identity in this domain is the EMAIL, not the account — an account only adds
 * `/me` and the host surface — so deleting one removes a way in, not a history.
 * Their planner rows do go: without them the account would keep granting
 * planning rights it can no longer be exercised with.
 */
export async function deleteAccount(userId: string, ownerId: string | null) {
  if (userId === ownerId) {
    throw createError({ statusCode: 422, message: 'The instance owner cannot be deleted.' })
  }
  const db = useDb()
  const [target] = await db.select({ id: guestUser.id, email: guestUser.email }).from(guestUser).where(eq(guestUser.id, userId)).limit(1)
  if (!target) throw createError({ statusCode: 404, message: 'Account not found' })

  const plannerRows = await db
    .delete(tables.eventPlanner)
    .where(eq(tables.eventPlanner.userId, userId))
    .returning({ id: tables.eventPlanner.id })
  // Sessions and provider rows cascade from the user row (schema/auth.ts).
  await db.delete(guestUser).where(eq(guestUser.id, userId))

  return { email: target.email, plannerRowsRemoved: plannerRows.length }
}
