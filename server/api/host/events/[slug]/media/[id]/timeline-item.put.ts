import { z } from 'zod'
import { setMediaTimelineItem } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Pin a ticket or a shared paper to a step of the itinerary, or take the pin
 * off (#38).
 *
 * THE READ NEEDED NO NEW ROUTE AND THE WRITE DID. `events_media.timeline_item_id`
 * has pinned media to a step since the transplant, and both media lists now
 * carry it — so the itinerary can render what is on a step without asking
 * anybody anything new. Nothing anywhere could SET it: the three media writes
 * that existed are the assignees, the ticket detail and the delete, and none of
 * them says which part of the plan a file belongs to. The issue asks a host to
 * pin from the itinerary without a round trip to the media page, and this is
 * the one verb that makes that sentence true.
 *
 * PUT rather than POST/DELETE for the reason `detail.put.ts` next door is a
 * PUT: the write REPLACES a single nullable value, so `{"timelineItemId":null}`
 * is the un-pin and there is no second route that could disagree with this one
 * about what re-pinning means. Idempotent in both directions.
 *
 * `timelineItemId` IS REQUIRED IN THE BODY AND NULLABLE, never optional. An
 * absent field and an explicit `null` would be the same request here, so a
 * client that forgot to send the id would silently un-pin instead of failing —
 * and un-pinning is the one outcome a planner cannot tell from "it did not
 * save" by looking at the screen.
 *
 * HOST-MANAGED, like the upload, the assignment and the delete beside it.
 * Guests read the pin on the invite link; only a planner writes it, and the
 * audit middleware records the mutation at the edge with no code here.
 */
const bodySchema = z.object({ timelineItemId: z.string().min(1).max(64).nullable() })

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const media = await setMediaTimelineItem(user.id, slug, id, body.timelineItemId)
  return { media }
})
