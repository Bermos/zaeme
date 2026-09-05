import { eq } from 'drizzle-orm'
import { getGuestSession } from '../utils/auth'
import { resolveInstanceOwnerId } from '../utils/instance'
import { eventSlugFromPath, recordAudit, type AuditActorKind, type AuditSurface } from '../domain/audit'
import { tables, useDb } from '../domain/db'

/**
 * The audit recorder for the HUMAN surfaces — one row per mutating request on
 * `/api/admin`, `/api/host`, `/api/me` and `/api/invites`.
 *
 * At the edge rather than in forty handlers, because "who did what" must be
 * complete: a handler-by-handler convention is one forgotten call away from a
 * silent hole, and the hole is always in the route somebody added in a hurry.
 *
 * ⚠️ `/api/v1` IS NOT AUDITED HERE, and the early return below is the whole
 * reason this file may resolve a session at all. The machine surface must never
 * have a cookie read anywhere near it (ADR-0036, `test/api-boundary.test.ts`);
 * it records itself, from its own credential, inside `defineServiceHandler`.
 *
 * `/api/auth` is skipped outright: magic-link tokens travel in those URLs and
 * an audit log is not a place to keep credentials.
 *
 * Only mutations are recorded. A log that also holds every GET is a traffic
 * log, and the interesting rows drown in it.
 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const SURFACES: Array<{ prefix: string, surface: AuditSurface }> = [
  { prefix: '/api/admin/', surface: 'admin' },
  { prefix: '/api/host/', surface: 'host' },
  { prefix: '/api/me/', surface: 'me' },
  { prefix: '/api/invites/', surface: 'invite' }
]

/** The invite whose capability URL this is — `/api/invites/<token>/…`. */
async function resolveInviteActor(path: string) {
  const token = /^\/api\/invites\/([^/?]+)/.exec(path)?.[1]
  if (!token) return null
  const [row] = await useDb()
    .select({ id: tables.invite.id, label: tables.invite.label, name: tables.invite.name, email: tables.invite.email })
    .from(tables.invite)
    .where(eq(tables.invite.token, token))
    .limit(1)
  if (!row) return null
  return { id: row.id, label: row.label ?? row.name ?? row.email ?? 'invite link' }
}

export default defineEventHandler(async (event) => {
  const path = getRequestURL(event).pathname
  // The machine surface audits itself; nothing here may touch it.
  if (path.startsWith('/api/v1') || path.startsWith('/api/auth')) return
  if (!MUTATING.has(event.method)) return

  const match = SURFACES.find(s => path.startsWith(s.prefix))
  if (!match) return

  let actorKind: AuditActorKind = 'anonymous'
  let actorId: string | null = null
  let actorLabel: string | null = null

  if (match.surface === 'invite') {
    const invite = await resolveInviteActor(path).catch(() => null)
    if (invite) {
      actorKind = 'guest'
      actorId = invite.id
      actorLabel = invite.label
    }
  } else {
    const session = await getGuestSession(event)
    if (session?.user) {
      actorId = session.user.id
      actorLabel = session.user.email
      actorKind = (await resolveInstanceOwnerId().catch(() => null)) === session.user.id ? 'owner' : 'planner'
    }
  }

  // The status is only known once the response is on the wire, so the row is
  // written from the `finish` hook — an attempt that 403s is exactly the kind
  // of thing this log exists to show.
  event.node.res.once('finish', () => {
    void recordAudit({
      actorKind,
      actorId,
      actorLabel,
      surface: match.surface,
      method: event.method,
      path,
      eventSlug: eventSlugFromPath(path),
      status: event.node.res.statusCode
    })
  })
})
