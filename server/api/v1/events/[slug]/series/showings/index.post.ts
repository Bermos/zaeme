import { z } from 'zod'
import { scheduleSeriesShowing } from '../../../../../../domain/index'
import { defineServiceHandler } from '../../../../../../utils/service-auth'
import { dispatchEvent } from '../../../../../../utils/dispatch'
import { showing } from '../../../../../../utils/v1-shapes'

/**
 * `scheduleSeriesShowing` — the movie-night path. Creates a published child
 * event and emails a personal invite to every standing member. No date poll:
 * the date passed IS the date.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  posterUrl: z.string().url().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  location: z.string().max(500).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await scheduleSeriesShowing(caller.planner.id, slug, body, { dispatch: dispatchEvent })
  setResponseStatus(event, 201)
  return showing(created)
})
