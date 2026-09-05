import { desc, like } from 'drizzle-orm'
import { tables, useDb } from './db'

/** Combining diacritical marks, stripped after NFD normalisation. */
const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * Slugify a string: lowercase, strip accents, hyphenate. Extracted from
 * `layers/events/server/utils/slugify.ts` (ported verbatim from zaeme; pure —
 * covered by the events layer's tests through its re-export).
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Generate a unique event slug, suffixing -2, -3, … on collision. */
export async function generateUniqueSlug(title: string): Promise<string> {
  const base = slugify(title) || 'event'

  const existing = await useDb()
    .select({ slug: tables.event.slug })
    .from(tables.event)
    .where(like(tables.event.slug, `${base}%`))
    .orderBy(desc(tables.event.slug))

  if (existing.length === 0) return base

  const existingSlugs = new Set(existing.map(r => r.slug))
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}
