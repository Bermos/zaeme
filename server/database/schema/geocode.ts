import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * THE GEOCODER CACHE (#32): what a place search asked, and what came back.
 *
 * Instance-level like the audit log, not events-domain, so it carries the
 * `zaeme_` prefix: a row is an answer about the WORLD, not about a gathering.
 * Two different trips looking for the same café ask the same question, and the
 * second one must not cost a request.
 *
 * WHY THIS IS A TABLE AND NOT A `Map` IN THE PROCESS. Nominatim's usage policy
 * is at most one request per second and it blocks instances that ignore it, so
 * the cache is not a latency optimisation — it is half of how the promise is
 * kept, the rate limiter in `server/domain/geocode.ts` being the other half. An
 * in-process cache is emptied by every deploy, and Kitchen deploys on every
 * merge to `main`; a planner who searched yesterday would pay for the same
 * lookup again today, and an instance that ever runs two replicas would pay
 * twice over. The row survives both, which is what makes a THIRTY-DAY ttl an
 * honest claim rather than a constant nobody reaches.
 *
 * `key` is the whole identity — `<provider>:<kind>:<normalised query>` — so the
 * primary key IS the lookup and a changed provider or a changed direction
 * cannot collide with a stored answer. See `geocodeCacheKey`.
 *
 * `results` is the ANSWER AS THE APP USES IT (`PlaceSuggestion[]`), not the
 * provider's raw payload. The mapping is the part most likely to change — a
 * renamed field, a different provider — and a cache holding mapped rows means
 * a mapping fix takes effect as the cache turns over rather than being wrong
 * for thirty days in a shape nothing re-reads. It also keeps a third party's
 * arbitrary JSON out of this database.
 *
 * NOTHING HERE IS PERSONAL DATA: the query is a place name somebody typed into
 * a search box, stored without who typed it, which event it was for or when
 * they are going. The one reason to say so out loud is that the obvious
 * "improvement" — recording the planner beside their searches — would turn a
 * cache into a log of what the instance's users are looking for, and that is a
 * decision for the owner rather than a column somebody adds while tidying.
 */
export const geocodeCache = pgTable('zaeme_geocode_cache', {
  /** `<provider>:<kind>:<normalised query>` — see `geocodeCacheKey`. */
  key: text('key').primaryKey(),
  /** Which geocoder answered: `nominatim` today, swappable by design. */
  provider: text('provider').notNull(),
  kind: text('kind', { enum: ['search', 'reverse'] }).notNull(),
  /** The normalised query, as it was sent — readable without parsing `key`. */
  query: text('query').notNull(),
  /** `PlaceSuggestion[]`, mapped. An empty array is a real answer. */
  results: jsonb('results').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * When this answer stops being usable.
   *
   * Written by the domain rather than computed here, because the two ttls are a
   * DECISION: a non-empty answer keeps for thirty days (place names do not
   * move) and an empty one for a day, since "no matches" is also what a
   * provider having a bad day looks like and it is the cheapest answer to ask
   * for again.
   */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, table => [
  // Expired rows are swept on a cache MISS, which is the only moment anything
  // here is already paying for a round trip. Nothing else visits this table, so
  // the sweep is what keeps it bounded.
  index('zaeme_geocode_cache_expires_idx').on(table.expiresAt)
])
