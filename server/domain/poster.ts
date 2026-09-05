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
