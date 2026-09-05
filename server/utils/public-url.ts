/**
 * Where this deployment is published, as one answer.
 *
 * The same question is asked from four places (invite emails, the iCal feed, the
 * co-organizer link the machine API hands back, the absolute poster URL the
 * concert projection stores), and it was being answered four slightly different
 * ways. `KITCHEN_URL` comes last because only a preview environment knows the
 * hostname the pull request was published on.
 *
 * Some bundlers set `BASE_URL` to a bare path like "/", which is not an origin
 * and must be ignored.
 */
export function publicOrigin(): string {
  const candidate = process.env.BASE_URL || process.env.BETTER_AUTH_URL || process.env.KITCHEN_URL || ''
  if (!/^https?:\/\//i.test(candidate)) return ''
  return candidate.replace(/\/+$/, '')
}

/** An absolute URL on this deployment's public origin, or the path unchanged. */
export function publicUrl(path: string): string {
  const origin = publicOrigin()
  const suffix = path.startsWith('/') ? path : `/${path}`
  return origin ? `${origin}${suffix}` : suffix
}
