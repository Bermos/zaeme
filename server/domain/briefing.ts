import { sql } from 'drizzle-orm'
import { useDb } from './db'
import type { RsvpSummary } from './events-data'

/**
 * The two Enterprise-facing briefing reads (ADR-0036, `/api/v1/snapshot` and
 * `/api/v1/attention`). Neither is model-facing; both are pure reads.
 *
 * ## The snapshot is the hot path
 *
 * Enterprise fetches it on EVERY XO turn, before any tool call, to assemble the
 * one-line events brief in the system prompt. Under the monolith that was two
 * indexed queries in-process; across the boundary it is a network hop on the
 * critical path of every conversation. So `buildSnapshot` is deliberately ONE
 * round trip: a single statement with a `mine` CTE and scalar sub-selects over
 * it. No fan-out, no N+1, no per-event follow-up — the attention COUNT is
 * computed in the same statement, and the attention FINDINGS are a separate
 * endpoint precisely so the hot path never pays for them.
 *
 * It also degrades rather than fails: a cold, empty or unreachable database
 * answers a valid snapshot with `degraded: true`, mirroring the `.catch(() =>
 * [])` stance the Enterprise-side builder had. The XO's brief is not the place
 * to fail.
 *
 * ## Attention is the check-in's other half
 *
 * `runEventsCheckIn` used to join zäme-owned facts (the next published event,
 * its RSVP summary) with Enterprise-owned thread state (the unread guard, the
 * once-a-day throttle) and then escalate. After the split, Enterprise keeps
 * every stateful part and this function keeps only the facts: it is stateless,
 * side-effect free and safe to call as often as the caller likes.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface SnapshotUpcoming {
  slug: string
  title: string
  status: string
  startsAt: string | null
}

export interface EventsSnapshot {
  summary: string
  highlights: string[]
  stats: Array<{ value: string, label: string }>
  data: {
    upcoming: SnapshotUpcoming[]
    draftCount: number
    needsAttentionCount: number
  }
  generatedAt: string
  degraded?: boolean
}

interface SnapshotRow {
  draft_count: number
  needs_attention_count: number
  upcoming: SnapshotUpcoming[] | null
}

function whenLabel(startsAt: string | null): string {
  return startsAt
    ? new Date(startsAt).toLocaleDateString('en-CH', { dateStyle: 'medium' })
    : 'a date TBD'
}

/** Shape a snapshot from the counts — shared by the happy and the degraded path. */
function shapeSnapshot(row: SnapshotRow, degraded: boolean): EventsSnapshot {
  const upcoming = row.upcoming ?? []
  const draftCount = Number(row.draft_count ?? 0)
  const needsAttentionCount = Number(row.needs_attention_count ?? 0)

  const highlights: string[] = []
  const next = upcoming[0]
  if (next) {
    highlights.push(`Next up: "${next.title}" on ${whenLabel(next.startsAt)} (${next.status}).`)
  }
  if (upcoming.length > 1) {
    highlights.push(`${upcoming.length} upcoming events on the calendar.`)
  }
  if (draftCount > 0) {
    highlights.push(`${draftCount} event${draftCount === 1 ? '' : 's'} still in draft — not yet published.`)
  }
  if (needsAttentionCount > 0) {
    highlights.push(`${needsAttentionCount} upcoming event${needsAttentionCount === 1 ? ' has' : 's have'} responses still outstanding.`)
  }

  return {
    // Always a complete sentence: an empty social calendar is a fact worth
    // stating, and this line lands verbatim in the XO's system prompt.
    summary: next
      ? `The user has ${upcoming.length} upcoming event${upcoming.length === 1 ? '' : 's'}; the next is "${next.title}".`
      : 'The user has no upcoming events scheduled.',
    highlights,
    stats: [
      { value: String(upcoming.length), label: 'UPCOMING' },
      { value: String(draftCount), label: 'DRAFTS' }
    ],
    data: { upcoming, draftCount, needsAttentionCount },
    generatedAt: new Date().toISOString(),
    ...(degraded ? { degraded: true } : {})
  }
}

/**
 * The whole snapshot in ONE statement.
 *
 * `mine` is the planner's events; everything else is a scalar sub-select over
 * that CTE, so Postgres evaluates it once. `upcoming` comes back pre-serialised
 * as JSON rather than as N rows joined against the counts.
 */
export async function buildSnapshot(
  userId: string,
  opts: { upcomingLimit?: number, horizonDays?: number } = {}
): Promise<EventsSnapshot> {
  const limit = Math.min(Math.max(opts.upcomingLimit ?? 5, 1), 20)
  const horizon = new Date(Date.now() + (opts.horizonDays ?? 14) * DAY_MS)

  try {
    const result = await useDb().execute(sql`
      with mine as (
        select e.id, e.slug, e.title, e.status, e.starts_at
        from events_event e
        join events_event_planner p on p.event_id = e.id
        where p.user_id = ${userId}
      ),
      outstanding as (
        select m.id
        from mine m
        left join events_rsvp r on r.event_id = m.id
        where m.status = 'published'
          and m.starts_at is not null
          and m.starts_at >= now()
          and m.starts_at <= ${horizon}
        group by m.id
        having count(r.id) = 0
            or count(*) filter (where r.status in ('maybe', 'no')) > 0
      )
      select
        (select count(*)::int from mine where status = 'draft') as draft_count,
        (select count(*)::int from outstanding) as needs_attention_count,
        (
          select coalesce(json_agg(u order by u.starts_at), '[]'::json)
          from (
            select slug, title, status, starts_at
            from mine
            where status <> 'cancelled'
              and starts_at is not null
              and starts_at >= now()
            order by starts_at
            limit ${limit}
          ) u
        ) as upcoming
    `)

    const raw = (result.rows[0] ?? {}) as Record<string, unknown>
    const upcoming = ((raw.upcoming ?? []) as Array<Record<string, unknown>>).map(u => ({
      slug: String(u.slug),
      title: String(u.title),
      status: String(u.status),
      startsAt: u.starts_at ? new Date(u.starts_at as string).toISOString() : null
    }))
    return shapeSnapshot({
      draft_count: Number(raw.draft_count ?? 0),
      needs_attention_count: Number(raw.needs_attention_count ?? 0),
      upcoming
    }, false)
  } catch (err) {
    // A cold or unreachable database is still answered with a usable snapshot.
    console.error('[zaeme:snapshot] degraded', err)
    return shapeSnapshot({ draft_count: 0, needs_attention_count: 0, upcoming: [] }, true)
  }
}

/* -------------------------------- attention ------------------------------- */

export interface AttentionFinding {
  kind: string
  summary: string
  detail: string
  urgency: 'low' | 'normal' | 'high'
  url?: string
  data: {
    slug: string
    eventId: string
    title: string
    startsAt: string | null
    daysAway: number | null
    summary?: RsvpSummary
  }
}

export interface AttentionResult {
  findings: AttentionFinding[]
  generatedAt: string
  degraded?: boolean
}

interface AttentionRow {
  id: string
  slug: string
  title: string
  status: string
  starts_at: string | null
  yes: number
  maybe: number
  no: number
  cheering: number
  total: number
  headcount: number
  vote_count: number
  option_count: number
}

const URGENCY_RANK = { high: 0, normal: 1, low: 2 } as const

/**
 * What in the social calendar warrants raising, most urgent first.
 *
 * The first finding class is `runEventsCheckIn`'s directive carried over
 * unchanged: the soonest published events inside the horizon that still have
 * people who have not confirmed, with the same "everyone answered and nobody
 * is on the fence" bail. Two more classes cover what the old check-in could
 * only have found by accident — a poll nobody has voted in, and a dated draft
 * inside the horizon that was never published.
 */
export async function findAttention(
  userId: string,
  opts: { horizonDays?: number, limit?: number } = {}
): Promise<AttentionResult> {
  const horizonDays = Math.min(Math.max(opts.horizonDays ?? 14, 1), 365)
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 20)
  const now = new Date()
  const horizon = new Date(now.getTime() + horizonDays * DAY_MS)

  let rows: AttentionRow[]
  try {
    const result = await useDb().execute(sql`
      select
        e.id, e.slug, e.title, e.status, e.starts_at,
        count(*) filter (where r.status = 'yes')::int as yes,
        count(*) filter (where r.status = 'maybe')::int as maybe,
        count(*) filter (where r.status = 'no')::int as no,
        count(*) filter (where r.status = 'cheering')::int as cheering,
        count(r.id)::int as total,
        (count(*) filter (where r.status in ('yes', 'cheering'))
          + count(*) filter (where r.status in ('yes', 'cheering') and r.plus_one))::int as headcount,
        (select count(*)::int from events_date_vote v where v.event_id = e.id) as vote_count,
        (select count(*)::int from events_date_option o where o.event_id = e.id) as option_count
      from events_event e
      join events_event_planner p on p.event_id = e.id and p.user_id = ${userId}
      left join events_rsvp r on r.event_id = e.id
      where e.status in ('published', 'polling', 'draft')
        and e.starts_at is not null
        and e.starts_at >= ${now}
        and e.starts_at <= ${horizon}
      group by e.id
      order by e.starts_at
    `)
    rows = result.rows as unknown as AttentionRow[]
  } catch (err) {
    console.error('[zaeme:attention] degraded', err)
    return { findings: [], generatedAt: new Date().toISOString(), degraded: true }
  }

  const findings: AttentionFinding[] = []

  for (const row of rows) {
    const startsAt = row.starts_at ? new Date(row.starts_at) : null
    const daysAway = startsAt ? Math.max(0, Math.round((startsAt.getTime() - now.getTime()) / DAY_MS)) : null
    const when = startsAt ? startsAt.toLocaleDateString('en-CH', { dateStyle: 'medium' }) : 'soon'
    const lead = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : daysAway != null ? `in ${daysAway} days` : 'soon'
    const summary: RsvpSummary = {
      yes: Number(row.yes), maybe: Number(row.maybe), no: Number(row.no),
      cheering: Number(row.cheering), total: Number(row.total), headcount: Number(row.headcount)
    }
    const data = {
      slug: row.slug,
      eventId: row.id,
      title: row.title,
      startsAt: startsAt ? startsAt.toISOString() : null,
      daysAway,
      summary
    }
    // The planner surface, not the guest page: the owner is the one being
    // nudged, and /host/<slug> is where they can actually act on it.
    const url = `/host/${row.slug}`

    if (row.status === 'published') {
      // The check-in's bail, unchanged: everyone answered and nobody wavered.
      if (summary.maybe === 0 && summary.total > 0 && summary.no === 0) continue
      const detailParts = [`${summary.headcount} coming`]
      if (summary.maybe) detailParts.push(`${summary.maybe} still maybe`)
      if (summary.total === 0) detailParts.push('no responses yet')
      findings.push({
        kind: 'events-upcoming',
        summary: `"${row.title}" is ${lead} (${when}).`,
        detail: `${detailParts.join(', ')}. You may want to nudge the people who haven't confirmed.`,
        urgency: daysAway != null && daysAway <= 2 ? 'high' : 'normal',
        url,
        data
      })
      continue
    }

    if (row.status === 'polling' && Number(row.option_count) > 0 && Number(row.vote_count) === 0) {
      findings.push({
        kind: 'events-poll-idle',
        summary: `Nobody has voted on the date poll for "${row.title}" yet.`,
        detail: `${row.option_count} candidate date${Number(row.option_count) === 1 ? '' : 's'} are up and the first one is ${lead} (${when}). Chasing the poll now leaves time to lock a date.`,
        urgency: daysAway != null && daysAway <= 3 ? 'high' : 'normal',
        url,
        data
      })
      continue
    }

    if (row.status === 'draft') {
      findings.push({
        kind: 'events-unpublished-draft',
        summary: `"${row.title}" is still a draft and it is ${lead} (${when}).`,
        detail: 'Nobody has been invited — publishing it is what sends the invite emails.',
        urgency: daysAway != null && daysAway <= 3 ? 'high' : 'normal',
        url,
        data
      })
    }
  }

  findings.sort((a, b) => {
    const rank = URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
    if (rank !== 0) return rank
    return (a.data.daysAway ?? Number.MAX_SAFE_INTEGER) - (b.data.daysAway ?? Number.MAX_SAFE_INTEGER)
  })

  return { findings: findings.slice(0, limit), generatedAt: new Date().toISOString() }
}
