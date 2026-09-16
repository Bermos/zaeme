import { z } from 'zod'
import { attachReceiptAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'
import { signBudgetReceipts } from '#server/utils/media-sign'

/**
 * Pin a photo already in the event's gallery to an expense as its receipt (#29).
 *
 * THE CREDENTIAL SPLIT THE ISSUE DRAWS RUNS THROUGH THE MIDDLE OF THIS ACTION.
 * Uploading the photo is a guest capability and stays one — `/api/invites/
 * {token}/media/presign` is untouched, and anyone holding the link may still
 * add to the gallery. Pinning it to an expense is an expense WRITE, so it is
 * here, on the account surface, behind the gate #48 put on the other three
 * verbs. The gate itself is in the domain, where a route cannot forget it.
 *
 * PUT rather than POST because it is one slot: an expense has a receipt or it
 * has none, and pinning a second replaces the first. Re-pinning the same photo
 * is a no-op that answers 200.
 *
 * It sends ONLY `mediaId`, and takes nothing else. A receipt is evidence a
 * reader can look at, not a claim about the figures — nothing here may relabel
 * `fxRateSource` or restate the amount on the uploader's behalf (#71).
 */
const bodySchema = z.object({
  mediaId: z.string().min(1).max(50)
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await attachReceiptAsParticipant(user, slug, id, body.mediaId)
  return { budget: await signBudgetReceipts(budget) }
})
