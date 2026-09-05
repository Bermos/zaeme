import { z } from 'zod'
import { calendarWindow } from '../../domain/index'
import { requireOwner } from '../../utils/admin'

/**
 * The calendar across every event in a window. The client asks for the month it
 * is showing (plus the days either side that a month grid spills over), so the
 * window is a parameter rather than "the next N".
 */
const querySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true })
})

export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const { from, to } = await getValidatedQuery(e, querySchema.parse)
  return { events: await calendarWindow(new Date(from), new Date(to)) }
})
