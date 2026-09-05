import { resolvePlannerInvite } from '../../../../domain/index'

/**
 * Preview a co-organizer invite — public read so the join page can show what
 * is being offered before asking the visitor to sign in and accept.
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const { invite, event } = await resolvePlannerInvite(token)
  return {
    eventTitle: event.title,
    eventSlug: event.slug,
    role: invite.role,
    emailRestricted: !!invite.email
  }
})
