import { and, eq, inArray } from 'drizzle-orm'
import { tables, useDb } from './db'

/**
 * Public poster art (ADR-0033 §4).
 *
 * `events_event.posterUrl` has always been a plain URL — the movie poster a host
 * pasted in from the web. Concerts announced out of the Enterprise Music
 * department break that assumption: their art is the FLYER the owner uploaded,
 * which lives in the shared object store under a `music/<userId>/…` key. Neither
 * of the obvious shortcuts works:
 *
 *   - a presigned URL expires (one hour), and `posterUrl` is persisted — the
 *     listing would go dark by the next morning;
 *   - the Enterprise download route (`/api/music/assets/…`) is owner-gated, and
 *     the zäme audience is by definition not the owner.
 *
 * So a poster key becomes a STABLE, relative URL on the zäme app, and the route
 * that serves it re-derives the authorisation from the events domain itself: the
 * bytes are served only while some public, published event actually points at
 * that key. Take the concert down and the poster stops resolving — there is no
 * second place to revoke.
 *
 * The check is deliberately expressed against `posterUrl` rather than against the
 * Music tables: zäme has no business knowing that a Music department exists, and
 * "an event I have published to the world links to this image" is the complete
 * and honest authorisation question.
 */

/** The route prefix zäme serves public poster art from. */
export const PUBLIC_POSTER_PREFIX = '/api/public/poster/'

/** The stable, non-expiring URL for an object-store key used as poster art. */
export function publicPosterUrl(storageKey: string): string {
  return `${PUBLIC_POSTER_PREFIX}${storageKey.split('/').map(encodeURIComponent).join('/')}`
}

/** Recover the storage key from a poster URL, or null when it isn't one of ours. */
export function posterKeyFromUrl(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(PUBLIC_POSTER_PREFIX)) return null
  const rest = url.slice(PUBLIC_POSTER_PREFIX.length)
  if (!rest) return null
  try {
    return rest.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
}

/**
 * Is this key currently published as the poster of a public event? The gate the
 * serving route applies before it reads a byte.
 */
export async function isPublicPosterKey(storageKey: string): Promise<boolean> {
  const rows = await useDb()
    .select({ id: tables.event.id })
    .from(tables.event)
    .where(and(
      eq(tables.event.posterUrl, publicPosterUrl(storageKey)),
      eq(tables.event.isPublic, true),
      inArray(tables.event.status, ['published', 'completed'])
    ))
    .limit(1)
  return rows.length > 0
}

/* ----------------------- content-addressed poster art ---------------------- */

/**
 * Posters uploaded THROUGH the machine API (`PUT /api/v1/media/posters/{sha256}`)
 * are content-addressed: the object key is the SHA-256 of the bytes, so
 * re-publishing an unchanged concert re-derives the same key, finds it already
 * stored, and costs nothing. A poster nothing references is zäme's to collect.
 *
 * The authorisation gate above is unchanged and still the whole story: the bytes
 * are inert until some public, published event's `posterUrl` points at them.
 */
export const POSTER_OBJECT_PREFIX = 'posters/'

/** The object-store key for a set of poster bytes, from their digest. */
export function posterObjectKey(sha256: string): string {
  return `${POSTER_OBJECT_PREFIX}${sha256}`
}

/** Lowercase-hex SHA-256, the only shape the content address may take. */
export function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/**
 * Reduce a poster URL to the relative form zäme persists on `event.posterUrl`.
 *
 * `uploadPoster` hands Enterprise an ABSOLUTE URL (the contract promises one it
 * can store and serve), but the row keeps the relative path — that is what the
 * `isPublicPosterKey` gate compares against and what `<img src>` and the OG card
 * want. Anything that is not one of ours passes through untouched: a movie
 * poster pasted from the web is still a perfectly good `posterUrl`.
 */
export function normalisePosterUrl(url: string | null | undefined): string | null {
  if (!url) return null
  if (url.startsWith(PUBLIC_POSTER_PREFIX)) return url
  const at = url.indexOf(PUBLIC_POSTER_PREFIX)
  // Only strip a leading origin, never a prefix found mid-path.
  if (at > 0 && /^https?:\/\/[^/]+$/.test(url.slice(0, at))) {
    return url.slice(at)
  }
  return url
}
