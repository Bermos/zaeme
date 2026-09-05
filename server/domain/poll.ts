import { and, asc, eq } from 'drizzle-orm'
import { createId } from '@paralleldrive/cuid2'
import { createError } from 'h3'
import { tables, useDb } from './db'
import { assertPlanner, loadEventBySlug } from './permissions'
import { canTransition, type EventDispatch } from './events-data'

/**
 * The date-finding availability poll (PUBLIC-SITE-PLAN "find a date that
 * works"): the host proposes date options on an event in `polling` status,
 * participants answer yes/ifneedbe/no per option, and the host locks the
 * winner — stamping `event.startsAt/endsAt` and publishing the event.
 */

export type PollAnswer = 'yes' | 'ifneedbe' | 'no'

export interface PollOptionView {
  id: string
  startsAt: Date
  endsAt: Date | null
  note: string | null
  votes: Array<{ name: string, answer: PollAnswer }>
  tally: { yes: number, ifneedbe: number, no: number }
}

/** Options + votes + tallies for an event, ordered as proposed. */
export async function loadPoll(eventId: string): Promise<PollOptionView[]> {
  const db = useDb()
  const options = await db
    .select()
    .from(tables.dateOption)
    .where(eq(tables.dateOption.eventId, eventId))
    .orderBy(asc(tables.dateOption.sortOrder), asc(tables.dateOption.startsAt))
  if (options.length === 0) return []

  const votes = await db
    .select({
      optionId: tables.dateVote.optionId,
      name: tables.dateVote.guestName,
      answer: tables.dateVote.answer
    })
    .from(tables.dateVote)
    .where(eq(tables.dateVote.eventId, eventId))

  return options.map((o) => {
    const forOption = votes.filter(v => v.optionId === o.id)
    const tally = { yes: 0, ifneedbe: 0, no: 0 }
    for (const v of forOption) tally[v.answer as PollAnswer] += 1
    return {
      id: o.id,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      note: o.note,
      votes: forOption.map(v => ({ name: v.name, answer: v.answer as PollAnswer })),
      tally
    }
  })
}

export interface AddDateOptionInput {
  startsAt: string | Date
  endsAt?: string | Date | null
  note?: string | null
}

/** Propose a date option (owner/co-planner only). */
export async function addDateOption(userId: string, slug: string, input: AddDateOptionInput) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  if (ev.status !== 'draft' && ev.status !== 'polling') {
    throw createError({ statusCode: 422, message: 'Date options can only be added while drafting or polling' })
  }

  const existing = await useDb()
    .select({ sortOrder: tables.dateOption.sortOrder })
    .from(tables.dateOption)
    .where(eq(tables.dateOption.eventId, ev.id))
  const sortOrder = existing.length ? Math.max(...existing.map(o => o.sortOrder)) + 10 : 0

  const [inserted] = await useDb()
    .insert(tables.dateOption)
    .values({
      id: createId(),
      eventId: ev.id,
      startsAt: input.startsAt instanceof Date ? input.startsAt : new Date(input.startsAt),
      endsAt: input.endsAt ? (input.endsAt instanceof Date ? input.endsAt : new Date(input.endsAt)) : null,
      note: input.note ?? null,
      sortOrder
    })
    .returning()
  return inserted
}

/** Withdraw a date option (owner/co-planner only; its votes cascade away). */
export async function removeDateOption(userId: string, slug: string, optionId: string): Promise<void> {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })
  await useDb()
    .delete(tables.dateOption)
    .where(and(eq(tables.dateOption.id, optionId), eq(tables.dateOption.eventId, ev.id)))
}

/**
 * Lock the winning date (owner/co-planner only): stamp the event's
 * `startsAt/endsAt` from the option and transition to `published` (firing the
 * caller's dispatch, which sends the invites). Allowed from `polling` (the
 * normal flow) or `draft` (host decided without a poll).
 */
export async function lockDate(
  userId: string,
  slug: string,
  optionId: string,
  opts: { dispatch?: EventDispatch } = {}
) {
  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, userId, { roles: ['owner', 'co_planner'] })

  const [option] = await useDb()
    .select()
    .from(tables.dateOption)
    .where(and(eq(tables.dateOption.id, optionId), eq(tables.dateOption.eventId, ev.id)))
    .limit(1)
  if (!option) throw createError({ statusCode: 404, message: 'Date option not found' })
  if (!canTransition(ev.status, 'published')) {
    throw createError({ statusCode: 422, message: `Cannot lock a date from status "${ev.status}"` })
  }

  const [updated] = await useDb()
    .update(tables.event)
    .set({ startsAt: option.startsAt, endsAt: option.endsAt, status: 'published' })
    .where(eq(tables.event.id, ev.id))
    .returning()

  if (opts.dispatch) {
    await opts.dispatch('events/event.published', { eventId: ev.id })
  }
  return updated
}
