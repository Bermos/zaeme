import { requireOwner } from '../../utils/admin'

/**
 * Who is asking, and may they be here — the admin surface's own gate, exposed
 * so the browser can decide what to render before it asks for data. 401 when
 * signed out, 403 when signed in as somebody who is not the owner.
 */
export default defineEventHandler(async (e) => {
  const owner = await requireOwner(e)
  return { owner: { id: owner.id, name: owner.name, email: owner.email } }
})
