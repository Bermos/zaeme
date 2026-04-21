import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { db } from './db'
import { optionalAuth } from './session'
import { assertPlanner } from './permissions'
import { resolveInviteToken } from './invite'
import { event, rsvp } from '#server/database/schema'

/**
 * Media type → allowed MIME prefixes. Kept permissive for `document`
 * (PDFs + common office formats) and `ticket` (PDF + PNG/JPG passes).
 */
export const MEDIA_TYPE_MIME: Record<'photo' | 'video' | 'document' | 'ticket', RegExp> = {
  photo: /^image\//,
  video: /^video\//,
  document: /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats|application\/vnd\.ms-|text\/)/,
  ticket: /^(application\/pdf|image\/png|image\/jpeg)$/
}

/** Per-type size limit in bytes. Enforced both on presign and confirm. */
export const MEDIA_TYPE_MAX_BYTES: Record<'photo' | 'video' | 'document' | 'ticket', number> = {
  photo: 25 * 1024 * 1024, // 25 MB
  video: 500 * 1024 * 1024, // 500 MB
  document: 25 * 1024 * 1024,
  ticket: 10 * 1024 * 1024
}

export type MediaType = keyof typeof MEDIA_TYPE_MIME

export interface MediaActor {
  kind: 'planner' | 'guest'
  userId: string | null
  rsvpId: string | null
  eventId: string
  eventSlug: string
  /** Present when kind === 'planner'. */
  plannerRole?: 'owner' | 'co_planner' | 'logistics'
}

interface ResolveActorOpts {
  /** Event slug (planner flow) — takes precedence when provided. */
  eventSlug?: string | null
  /** Invite/RSVP token (guest flow). */
  rsvpToken?: string | null
  /** If true, only allow uploads for events currently accepting contributions. */
  forUpload?: boolean
}

/**
 * Resolve the caller into either a planner of the target event or a guest
 * identified by their invite/RSVP token. Throws 401/403/404 as appropriate.
 *
 * Contribution rules:
 *   - Planners may upload at any event status except `cancelled`.
 *   - Guests must have an RSVP of yes/maybe/cheering and the event must be
 *     published or completed (memories mode). `draft` and `cancelled` reject.
 */
export async function resolveMediaActor(e: H3Event, opts: ResolveActorOpts): Promise<MediaActor> {
  if (opts.eventSlug) {
    const session = await optionalAuth(e)
    if (!session?.user) {
      throw createError({ statusCode: 401, message: 'Unauthorized' })
    }
    const [ev] = await db.select().from(event).where(eq(event.slug, opts.eventSlug)).limit(1)
    if (!ev) {
      throw createError({ statusCode: 404, message: 'Event not found' })
    }
    const role = await assertPlanner(ev.id, session.user.id)
    if (opts.forUpload && ev.status === 'cancelled') {
      throw createError({ statusCode: 409, message: 'Cancelled events cannot accept uploads' })
    }
    return {
      kind: 'planner',
      userId: session.user.id,
      rsvpId: null,
      eventId: ev.id,
      eventSlug: ev.slug,
      plannerRole: role
    }
  }

  if (opts.rsvpToken) {
    const { invite: inv, event: ev } = await resolveInviteToken(opts.rsvpToken)
    // Guest must have already RSVP'd to this invite.
    const [guestRsvp] = await db
      .select()
      .from(rsvp)
      .where(and(eq(rsvp.eventId, ev.id), eq(rsvp.inviteId, inv.id)))
      .limit(1)

    if (!guestRsvp) {
      throw createError({ statusCode: 403, message: 'RSVP required before uploading' })
    }
    if (opts.forUpload) {
      if (ev.status !== 'published' && ev.status !== 'completed') {
        throw createError({ statusCode: 409, message: 'This event is not currently accepting uploads' })
      }
      if (guestRsvp.status === 'no') {
        throw createError({ statusCode: 403, message: 'Only attending guests can upload media' })
      }
    }
    return {
      kind: 'guest',
      userId: guestRsvp.userId,
      rsvpId: guestRsvp.id,
      eventId: ev.id,
      eventSlug: ev.slug
    }
  }

  throw createError({ statusCode: 400, message: 'Either eventSlug (planner) or rsvpToken (guest) is required' })
}
