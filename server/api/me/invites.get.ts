import { listInvitesForEmail } from '../../domain/index'
import { requireGuestUser } from '../../utils/auth'

/**
 * "All my invites in one place" — the cross-event aggregation, gated behind a
 * signed-in zäme account (ADR-0019 §3: capability links stay per-event; only a
 * real session may aggregate).
 */
export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  return listInvitesForEmail(user.email)
})
