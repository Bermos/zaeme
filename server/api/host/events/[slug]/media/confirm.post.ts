import { z } from 'zod'
import { assertPlanner, confirmMediaUpload, loadEventBySlug } from '../../../../../domain/index'
import { requireGuestUser } from '../../../../../utils/auth'
import { assertStorageConfigured } from '../../../../../utils/media-sign'

/** Two-step host upload, step 2: mark ready (planner only). */
const bodySchema = z.object({
  mediaId: z.string().min(1).max(50),
  caption: z.string().max(2000).optional().nullable(),
  takenAt: z.string().optional().nullable()
})

export default defineEventHandler(async (e) => {
  assertStorageConfigured()
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)

  const ev = await loadEventBySlug(slug)
  await assertPlanner(ev.id, user.id, { roles: ['owner', 'co_planner'] })

  const media = await confirmMediaUpload(ev.id, body.mediaId, { caption: body.caption, takenAt: body.takenAt })
  return { media }
})
