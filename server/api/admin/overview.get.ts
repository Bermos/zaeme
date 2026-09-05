import { instanceOverview } from '../../domain/index'
import { requireOwner } from '../../utils/admin'

/** The admin landing page's numbers — one statement, see `instanceOverview`. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return instanceOverview()
})
