import { z } from 'zod'
import { scheduleOccurrence } from '../../../../domain/index'
import { requireGuestUser } from '../../../../utils/auth'
import { dispatchEvent } from '../../../../utils/dispatch'

/**
 * Schedule the next showing of a series: creates a published child event and
 * emails every standing member their personal invite (no date poll — the
 * showtime IS the showtime).
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  posterUrl: z.string().url().max(1000).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional().nullable(),
  location: z.string().max(300).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const occurrence = await scheduleOccurrence(user.id, slug, body, { dispatch: dispatchEvent })
  return { occurrence }
})
