import { getInvitePage } from '../../../domain/index'
import { signBudgetReceipts } from '../../../utils/media-sign'

/**
 * The guest event page, in one resolve (capability URL — the token is the
 * credential): event + film post, attendees, timeline, date poll, bring list,
 * and the targeted invitee's existing RSVP. SSR renders `/i/[token]` off this.
 *
 * THE BUDGET COMES OUT OF HERE TOO, nested, which is why the receipts are
 * signed on this route as well as on `budget.get.ts`. It is the ONE budget
 * handler that does not name a budget anywhere in its own source — it returns
 * whatever `getInvitePage` built — and it is therefore the one a rule written
 * over handler source misses. `test/api-boundary.test.ts` works the set out
 * from the DOMAIN instead, transitively, so a new route that reaches a budget
 * through a function nobody has thought of yet is still caught.
 */
export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const page = await getInvitePage(token)
  if (page.budget) page.budget = await signBudgetReceipts(page.budget)
  return page
})
