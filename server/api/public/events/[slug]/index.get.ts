import { getPublicEventPage } from '../../../../domain/index'

/** One public event page: the post, who's going, the counts. No auth. */
export default defineEventHandler(async (e) => {
  const slug = getRouterParam(e, 'slug')!
  return getPublicEventPage(slug)
})
