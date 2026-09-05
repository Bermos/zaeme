import { seriesOverview } from '../../domain/index'
import { requireOwner } from '../../utils/admin'

/** Every series and its occurrences — two statements, whatever the count. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { series: await seriesOverview() }
})
