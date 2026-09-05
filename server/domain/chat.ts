import { and, asc, eq, gt } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'

/**
 * The per-event group chat ("who's driving?", "I'll be 10 late"). Plain
 * request/response — clients poll while the panel is open; there is no
 * realtime primitive on the guest surface and none is needed (single-tenant
 * latency posture). Authors are the same name+email identity as RSVPs; a
 * planner posting from the host side carries their userId (badged as host).
 */

export interface MessageView {
  id: string
  authorName: string
  authorEmail: string
  isHost: boolean
  body: string
  createdAt: Date
}

const MAX_PAGE = 200

/** Messages in chronological order; pass `afterId` to poll for just the new ones. */
export async function listMessages(
  eventId: string,
  opts: { afterId?: string | null, limit?: number } = {}
): Promise<MessageView[]> {
  const db = useDb()
  const conditions = [eq(tables.message.eventId, eventId)]

  if (opts.afterId) {
    const [anchor] = await db
      .select({ createdAt: tables.message.createdAt })
      .from(tables.message)
      .where(and(eq(tables.message.id, opts.afterId), eq(tables.message.eventId, eventId)))
      .limit(1)
    if (anchor) conditions.push(gt(tables.message.createdAt, anchor.createdAt))
  }

  const rows = await db
    .select()
    .from(tables.message)
    .where(and(...conditions))
    .orderBy(asc(tables.message.createdAt), asc(tables.message.id))
    .limit(Math.min(opts.limit ?? MAX_PAGE, MAX_PAGE))

  return rows.map(r => ({
    id: r.id,
    authorName: r.authorName,
    authorEmail: r.authorEmail,
    isHost: !!r.authorUserId,
    body: r.body,
    createdAt: r.createdAt
  }))
}

export interface PostMessageInput {
  body: string
  authorName: string
  authorEmail: string
  /** Set when a planner posts from the host surface. */
  authorUserId?: string | null
}

/** Append a message to the event's chat. */
export async function postMessage(eventId: string, input: PostMessageInput): Promise<MessageView> {
  const body = input.body.trim()
  if (!body) {
    throw createError({ statusCode: 422, message: 'A message needs some words' })
  }
  const [inserted] = await useDb()
    .insert(tables.message)
    .values({
      id: createId(),
      eventId,
      authorName: input.authorName,
      authorEmail: input.authorEmail.toLowerCase(),
      authorUserId: input.authorUserId ?? null,
      body
    })
    .returning()
  return {
    id: inserted!.id,
    authorName: inserted!.authorName,
    authorEmail: inserted!.authorEmail,
    isHost: !!inserted!.authorUserId,
    body: inserted!.body,
    createdAt: inserted!.createdAt
  }
}

/* --------------------------- planner-scoped shape --------------------------- */

/** Chat for a planner of the event — same `(userId, slug)` shape as events-data. */
export async function listMessagesForPlanner(userId: string, slug: string, opts: { afterId?: string | null } = {}) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return listMessages(ev.id, opts)
}

/** Post to the chat as a planner (badged as host). */
export async function postMessageAsPlanner(
  userId: string,
  slug: string,
  input: { body: string, authorName: string, authorEmail: string }
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId)
  return postMessage(ev.id, { ...input, authorUserId: userId })
}
