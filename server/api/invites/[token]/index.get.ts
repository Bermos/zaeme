import { getInvitePage } from '../../../domain/index'

/**
 * The guest event page, in one resolve (capability URL — the token is the
 * credential): event + film post, attendees, timeline, date poll, bring list,
 * and the targeted invitee's existing RSVP. SSR renders `/i/[token]` off this.
 */
export default defineEventHandler((e) => {
  const token = getRouterParam(e, 'token')!
  return getInvitePage(token)
})
