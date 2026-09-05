import { listMedia } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { mediaItem } from '../../../../utils/v1-shapes'

/**
 * `listMedia` — metadata only. No download URLs cross the boundary: the bytes
 * live in zäme and are served to guests there.
 */
export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  return (await listMedia(caller.planner.id, slug)).map(mediaItem)
})
