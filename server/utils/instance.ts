import { asc } from 'drizzle-orm'
import { useDb } from './db'
import { guestUser } from '../database/schema/auth'

/**
 * Who owns this instance, and has anybody claimed it yet.
 *
 * zäme is self-hostable: a fresh deployment has an empty database and no way
 * in. The first account created is the instance owner — that is the whole of
 * the first-run bootstrap (`server/middleware/setup.ts` → `/setup`).
 *
 * This replaces the `resolveInstanceOwnerId()` that lived in the shared events
 * package while zäme was inside the Enterprise monorepo. That one read the
 * *Enterprise* owner's `user` table to attribute guests to an ontology Person —
 * meaningless now that zäme owns its own database and has no ontology. The
 * question that remains is the honest one: has this instance been set up?
 */

/** The instance owner's user id — the first account registered, or null. */
export async function resolveInstanceOwnerId(): Promise<string | null> {
  const [row] = await useDb()
    .select({ id: guestUser.id })
    .from(guestUser)
    .orderBy(asc(guestUser.createdAt))
    .limit(1)
  return row?.id ?? null
}

/** True while no account exists at all — the instance still needs its owner. */
export async function isSetupRequired(): Promise<boolean> {
  return (await resolveInstanceOwnerId()) === null
}

/** The instance owner as a planner identity — id, name and email. */
export interface InstancePlanner {
  id: string
  name: string
  email: string
}

/**
 * The planner the Enterprise service token acts as: this instance's owner
 * account, in full. `postEventChatMessage` needs a display name and an email
 * for the message it writes, and the contract is explicit that the host's name
 * on a zäme message is zäme's own fact about its planner — Enterprise no
 * longer supplies one.
 *
 * Memoised for a minute because EVERY `/api/v1` call resolves it, including the
 * snapshot Enterprise fetches on every XO turn — and without the cache that hot
 * path costs two round trips where the work is one. Only a HIT is cached: a
 * fresh instance with no owner yet must keep asking, or first-run setup would
 * not take effect for a minute. The TTL exists so a renamed owner does not stay
 * stale forever.
 */
const PLANNER_TTL_MS = 60_000
let _planner: { value: InstancePlanner, at: number } | null = null

export async function resolveInstancePlanner(): Promise<InstancePlanner | null> {
  if (_planner && Date.now() - _planner.at < PLANNER_TTL_MS) {
    return _planner.value
  }
  const [row] = await useDb()
    .select({ id: guestUser.id, name: guestUser.name, email: guestUser.email })
    .from(guestUser)
    .orderBy(asc(guestUser.createdAt))
    .limit(1)
  if (row) _planner = { value: row, at: Date.now() }
  return row ?? null
}
