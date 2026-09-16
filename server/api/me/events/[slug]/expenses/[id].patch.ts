import { z } from 'zod'
import { updateExpenseAsParticipant } from '#server/domain/index'
import { requireGuestUser } from '#server/utils/auth'

/**
 * Correct an expense as a signed-in participant of the event (#27).
 *
 * ANY expense on the trip, not only your own: a shared ledger among friends
 * works because whoever remembers the taxi was 88.40 can fix it. The gate is
 * the one `POST` on this surface uses (`assertParticipant`, in the domain) and
 * nothing here widens it — an unauthenticated request never reaches the
 * handler, and a signed-in account with no standing on the event is refused by
 * the domain.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS UNCHANGED. `null` is a value two of
 * them take — `note: null` clears the note and `accountId: null` moves the cost
 * to Uncategorised — so `.optional().nullable()` and `.optional()` are
 * deliberately different here rather than interchangeable.
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200).optional(),
  /** By NAME, case-insensitively, exactly as on the write. `null` is Uncategorised. */
  category: z.string().min(1).max(60).optional().nullable(),
  /** The category account outright. Wins over `category`. `null` is Uncategorised. */
  accountId: z.string().min(1).max(64).optional().nullable(),
  amountCents: z.number().int().positive().optional(),
  currency: z.string().length(3).optional(),
  // Stating either one records the row as a figure somebody checked. Leave both
  // out and an edited amount rides on the rate this expense was frozen at.
  fxRate: z.string().regex(/^\d{1,9}(\.\d{1,10})?$/).optional(),
  targetAmountCents: z.number().int().positive().optional(),
  note: z.string().max(500).optional().nullable(),
  // Both halves or neither: the domain refuses one alone rather than renaming
  // whoever holds the other.
  paidByName: z.string().min(1).max(200).optional(),
  paidByEmail: z.email().optional(),
  // Only ever beside `participants` — the domain refuses a mode with no numbers
  // behind it. Omit both and the split is re-derived from what was recorded.
  splitMode: z.enum(['even', 'exact', 'percentage', 'weight']).optional(),
  participants: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.email(),
    amountCents: z.number().int().min(0).optional(),
    weight: z.string().regex(/^\d{1,8}(\.\d{1,4})?$/).optional()
  })).min(1).max(50).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const slug = getRouterParam(e, 'slug')!
  const id = getRouterParam(e, 'id')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const budget = await updateExpenseAsParticipant(user, slug, id, body)
  return { budget }
})
