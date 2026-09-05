import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { useDb } from './db'
import { auditLog } from '../database/schema/audit'

/**
 * The instance audit log's domain half: how a row is written and how the admin
 * surface reads it back.
 *
 * Writing NEVER throws. An audit row is a record of something that already
 * happened; failing the request because the record failed would trade a
 * completed action for a lost one. Everything here catches and logs.
 */

export type AuditActorKind = 'owner' | 'planner' | 'guest' | 'service' | 'anonymous'
export type AuditSurface = 'admin' | 'host' | 'me' | 'invite' | 'machine'

export interface AuditEntry {
  actorKind: AuditActorKind
  actorId?: string | null
  actorLabel?: string | null
  surface: AuditSurface
  method: string
  path: string
  eventSlug?: string | null
  status?: number | null
  meta?: Record<string, unknown> | null
}

/** The `:slug` of `/api/{host,admin}/events/:slug/...`, when the path has one. */
export function eventSlugFromPath(path: string): string | null {
  return /\/events\/([^/?]+)/.exec(path)?.[1] ?? null
}

/** Record one action. Fire-and-forget: awaited by callers that can, never fatal. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await useDb().insert(auditLog).values({
      id: createId(),
      actorKind: entry.actorKind,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      surface: entry.surface,
      method: entry.method,
      path: entry.path,
      eventSlug: entry.eventSlug ?? null,
      status: entry.status ?? null,
      meta: entry.meta ?? null
    })
  } catch (err) {
    console.error('[zaeme:audit] could not record', { path: entry.path, err })
  }
}

export interface AuditQuery {
  surface?: AuditSurface
  actorKind?: AuditActorKind
  eventSlug?: string
  /** Only failures — everything that did not answer 2xx. */
  failuresOnly?: boolean
  limit?: number
  before?: Date
}

/** The log, newest first, with the filters the admin surface offers. */
export async function listAudit(query: AuditQuery = {}) {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500)
  const where = [
    query.surface ? eq(auditLog.surface, query.surface) : undefined,
    query.actorKind ? eq(auditLog.actorKind, query.actorKind) : undefined,
    query.eventSlug ? eq(auditLog.eventSlug, query.eventSlug) : undefined,
    query.failuresOnly ? sql`(${auditLog.status} is null or ${auditLog.status} >= 400)` : undefined,
    query.before ? lt(auditLog.at, query.before) : undefined
  ].filter(Boolean)

  return useDb()
    .select()
    .from(auditLog)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(auditLog.at))
    .limit(limit)
}

/**
 * Counts for the audit header — one grouped statement per axis rather than a
 * count query per surface, which is the same N+1 trap the cross-event views
 * have to avoid.
 */
export async function summariseAudit(sinceDays = 7) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
  const db = useDb()

  const [bySurface, byActor, [totals]] = await Promise.all([
    db
      .select({ surface: auditLog.surface, count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(gte(auditLog.at, since))
      .groupBy(auditLog.surface),
    db
      .select({ actorKind: auditLog.actorKind, count: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(gte(auditLog.at, since))
      .groupBy(auditLog.actorKind),
    db
      .select({
        total: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where ${auditLog.status} is null or ${auditLog.status} >= 400)::int`,
        oldest: sql<Date | null>`min(${auditLog.at})`,
        newest: sql<Date | null>`max(${auditLog.at})`
      })
      .from(auditLog)
  ])

  return { sinceDays, bySurface, byActor, totals: totals ?? { total: 0, failures: 0, oldest: null, newest: null } }
}

/** Drop entries older than `days`. The owner's retention control; itself audited. */
export async function pruneAudit(days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const removed = await useDb().delete(auditLog).where(lt(auditLog.at, cutoff)).returning({ id: auditLog.id })
  return removed.length
}

/** When did Enterprise last call the machine API, and how often lately? */
export async function machineActivity(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
  const [row] = await useDb()
    .select({
      lastAt: sql<Date | null>`max(${auditLog.at})`,
      writes: sql<number>`count(*) filter (where ${auditLog.at} >= ${since})::int`,
      failures: sql<number>`count(*) filter (where ${auditLog.at} >= ${since} and ${auditLog.status} >= 400)::int`
    })
    .from(auditLog)
    .where(eq(auditLog.surface, 'machine'))
  return row ?? { lastAt: null, writes: 0, failures: 0 }
}
