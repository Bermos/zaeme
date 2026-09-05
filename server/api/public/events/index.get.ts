import { listPublicEvents } from '../../../domain/index'

/** Upcoming public events (concerts mostly) — the open listing, no auth. */
export default defineEventHandler(async () => {
  const events = await listPublicEvents()
  return { events }
})
