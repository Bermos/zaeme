import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The instance audit log — "who did what on this zäme".
 *
 * Instance-level, not events-domain, so it carries the `zaeme_` prefix
 * alongside the auth tables: it records ACTIONS, and an action belongs to a
 * credential rather than to a gathering.
 *
 * A row is written for every mutating request that reaches a credentialled
 * surface, by exactly two writers:
 *
 *  - `server/middleware/audit.ts` — the human surfaces (`/api/host`,
 *    `/api/admin`, `/api/me`, `/api/invites`), where the actor is a session or
 *    a capability token. That middleware NEVER looks at `/api/v1`.
 *  - `defineServiceHandler` (`server/utils/service-auth.ts`) — the machine
 *    surface, where the actor is Enterprise's service token and the row also
 *    carries the provenance headers the call arrived with.
 *
 * Failures are recorded too: a 401 on `/api/admin` is precisely the thing an
 * audit exists to show. `status` is the response code, so an attempt and a
 * success are distinguishable.
 *
 * NOTE on scope: this records the ACT, not the diff. Linking a written row back
 * to the sentence in an XO thread that caused it is issue #12 and wants its own
 * table; `meta.thread` here is the thread id, which is as far as an
 * edge-recorded log can honestly go.
 */
export const auditLog = pgTable('zaeme_audit_log', {
  id: text('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  /** Which credential acted: the owner's session, another planner's, a guest's link, Enterprise. */
  actorKind: text('actor_kind', { enum: ['owner', 'planner', 'guest', 'service', 'anonymous'] }).notNull(),
  /** The account id, the invite id, or null when the request never authenticated. */
  actorId: text('actor_id'),
  /** Something human-readable: an email, an invite label, "Enterprise". */
  actorLabel: text('actor_label'),
  /** Which surface the call came in on: admin | host | me | invite | machine. */
  surface: text('surface', { enum: ['admin', 'host', 'me', 'invite', 'machine'] }).notNull(),
  method: text('method').notNull(),
  /** The concrete request path, ids and all. */
  path: text('path').notNull(),
  /** The event this touched, when the path names one — the audit's main filter. */
  eventSlug: text('event_slug'),
  /** HTTP status of the response. Null only if the connection died first. */
  status: integer('status'),
  /** Provenance and anything else worth keeping; never request bodies. */
  meta: jsonb('meta').$type<Record<string, unknown>>()
}, table => [
  index('zaeme_audit_log_at_idx').on(table.at),
  index('zaeme_audit_log_actor_idx').on(table.actorKind, table.at),
  index('zaeme_audit_log_surface_idx').on(table.surface, table.at),
  index('zaeme_audit_log_event_idx').on(table.eventSlug)
])
