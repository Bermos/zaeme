import { z } from 'zod'
import { guestAddLeg } from '../../../domain/index'

/**
 * "We ended up walking" — a guest records how they actually got between two of
 * the trip's places (#30).
 *
 * THE LINK IS THE CREDENTIAL here, deliberately, and this is not the judgement
 * money got in #48: a leg is a note about the afternoon and not a claim on
 * anybody's wallet, and the whole point is that it is written while the host is
 * asleep. `resolveInviteToken` inside the domain is what still applies
 * revocation, expiry, the use-count limit and the `draft`/`cancelled` lifecycle
 * refusal — no session is read here, and `test/api-boundary.test.ts` asserts it.
 *
 * There is no `isPlanned` in this schema: the guest surface records what
 * HAPPENED (`isPlanned: false`), and letting a forwarded link declare the
 * group's intentions is a different thing entirely.
 */
const bodySchema = z.object({
  fromPlaceId: z.string().min(1).max(64),
  toPlaceId: z.string().min(1).max(64),
  mode: z.enum(['walk', 'bike', 'car', 'train', 'bus', 'ferry', 'plane', 'other']),
  departsAt: z.iso.datetime({ offset: true }).optional().nullable(),
  arrivesAt: z.iso.datetime({ offset: true }).optional().nullable(),
  durationMinutes: z.number().int().min(0).max(100000).optional().nullable(),
  note: z.string().max(2000).optional().nullable()
})

export default defineEventHandler(async (e) => {
  const token = getRouterParam(e, 'token')!
  const body = await readValidatedBody(e, bodySchema.parse)
  const geography = await guestAddLeg(token, body)
  setResponseStatus(e, 201)
  return geography
})
