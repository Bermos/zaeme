import { z } from 'zod'
import { scheduleSeriesShowing } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { dispatchEvent } from '#server/utils/dispatch'
import { showing } from '#server/utils/v1-shapes'

/**
 * `scheduleSeriesShowing` — the movie-night path. Creates a published child
 * event and emails a personal invite to every standing member. No date poll:
 * the date passed IS the date.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  posterUrl: z.url().optional(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  location: z.string().max(500).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await scheduleSeriesShowing(caller.planner.id, slug, body, { dispatch: dispatchEvent })
  setResponseStatus(event, 201)
  return showing(created)
})
