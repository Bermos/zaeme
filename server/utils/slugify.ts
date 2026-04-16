import { like, desc } from 'drizzle-orm'
import { db } from './db'
import { event } from '../database/schema/events'

/**
 * Slugify a string: lowercase, replace spaces/special chars with hyphens.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/**
 * Generate a unique slug for an event title, with collision handling.
 */
export async function generateUniqueSlug(title: string): Promise<string> {
  const base = slugify(title) || 'event'

  // Check for existing slugs that start with base
  const existing = await db
    .select({ slug: event.slug })
    .from(event)
    .where(like(event.slug, `${base}%`))
    .orderBy(desc(event.slug))

  if (existing.length === 0) return base

  const existingSlugs = new Set(existing.map(r => r.slug))
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}
