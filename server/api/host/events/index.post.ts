import { z } from 'zod'
import { addPlanner, createEvent, createParty } from '../../../domain/index'
import { requireGuestUser } from '../../../utils/auth'
import { resolveInstanceOwnerId } from '../../../utils/instance'

/**
 * Create a gathering. The creator becomes the owner planner; this instance's
 * owner — the account that claimed it at /setup — is attached as a co-planner
 * too, so a self-hosted instance's admin can see and rescue anything planned
 * on it. On the usual instance those are the same person and the second write
 * never happens.
 *
 * Convenience fast-path: `type: 'party'` with `coreInvites` + `dateOptions`
 * sets up the whole first stage in one call (party created, dates seeded,
 * core group invited, poll open).
 */
const bodySchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(['hosted', 'concert', 'series', 'trip', 'party']).optional(),
  description: z.string().max(5000).optional().nullable(),
  posterUrl: z.string().url().max(1000).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }).optional().nullable(),
  endsAt: z.string().datetime({ offset: true }).optional().nullable(),
  cadence: z.string().max(200).optional().nullable(),
  ticketUrl: z.string().url().max(1000).optional().nullable(),
  performerNote: z.string().max(1000).optional().nullable(),
  // Party fast-path (stage 1 in one call)
  coreInvites: z.array(z.object({
    name: z.string().min(1).max(200),
    email: z.string().email().optional().nullable()
  })).max(20).optional(),
  dateOptions: z.array(z.object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }).optional().nullable(),
    note: z.string().max(500).optional().nullable()
  })).max(10).optional()
})

export default defineEventHandler(async (e) => {
  const user = await requireGuestUser(e)
  const body = await readValidatedBody(e, bodySchema.parse)

  let id: string
  let slug: string
  if (body.type === 'party' && body.coreInvites?.length && body.dateOptions?.length) {
    const party = await createParty(user.id, {
      title: body.title,
      description: body.description,
      posterUrl: body.posterUrl,
      location: body.location,
      coreInvites: body.coreInvites,
      dateOptions: body.dateOptions
    })
    id = party.id
    slug = party.slug
  } else {
    const created = await createEvent(user.id, body)
    id = created.id
    slug = created.slug
  }

  const instanceOwner = await resolveInstanceOwnerId()
  if (instanceOwner && instanceOwner !== user.id) {
    await addPlanner(id, instanceOwner, 'co_planner')
  }

  return { id, slug }
})
