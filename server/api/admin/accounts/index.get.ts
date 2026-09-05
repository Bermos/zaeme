import { listAccounts } from '../../../domain/index'
import { requireOwner } from '../../../utils/admin'
import { resolveInstanceOwnerId } from '../../../utils/instance'

/** The accounts on this instance, and which one owns it. */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return { accounts: await listAccounts(await resolveInstanceOwnerId()) }
})
