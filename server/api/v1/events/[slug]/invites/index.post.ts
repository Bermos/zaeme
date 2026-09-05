import { z } from 'zod'
import { createInvite } from '#server/domain/index'
import { defineServiceHandler } from '#server/utils/service-auth'
import { invite } from '#server/utils/v1-shapes'

/** `createInvite` — a shareable link, or a targeted personal invite when `email` is set. */
const bodySchema = z.object({
  label: z.string().max(120).optional(),
  email: z.email().optional(),
  name: z.string().max(120).optional(),
  maxUses: z.number().int().min(1).max(10000).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const created = await createInvite(caller.planner.id, slug, body)
  setResponseStatus(event, 201)
  return invite(created!)
})
