import { guestLoadGeography } from '../../../domain/index'

/**
 * The trip's map over the invite capability URL — the token IS the credential,
 * as everywhere else under `/api/invites/**`. The guest page is SSR'd with this
 * inside `GET /api/invites/[token]`; this is the refresh after somebody adds a
 * leg, in the shape `guestLoadBudget` established next door.
 */
export default defineEventHandler((e) => {
  const token = getRouterParam(e, 'token')!
  return guestLoadGeography(token)
})
