import { z } from 'zod'
import { loadEventBySlug, openUpParty } from '../../../../domain/index'
import { defineServiceHandler } from '../../../../utils/service-auth'
import { asInvalidTransition } from '../../../../utils/api-v1'
import { dispatchEvent } from '../../../../utils/dispatch'
import { publicUrl } from '../../../../utils/public-url'
import { invite } from '../../../../utils/v1-shapes'

/**
 * `openUpParty` — stage two: mint the shareable open-invitation link for the
 * wider circle, with the absolute URL already assembled.
 */
const bodySchema = z.object({
  label: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(10000).optional()
}).strict()

export default defineServiceHandler(async (event, caller) => {
  const slug = getRouterParam(event, 'slug')!
  const body = bodySchema.parse(await readBody(event))
  const current = await loadEventBySlug(slug)
  const opened = await asInvalidTransition(
    () => openUpParty(caller.planner.id, slug, body, { dispatch: dispatchEvent }),
    { from: current.status, to: 'open' }
  )
  setResponseStatus(event, 201)
  return { ...invite(opened), url: publicUrl(`/i/${opened.token}`) }
})
