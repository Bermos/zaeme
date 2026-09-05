import { storageUsage } from '../../domain/index'
import { requireOwner } from '../../utils/admin'
import { isStorageConfigured, readStorageConfig } from '../../utils/storage'

/**
 * What this instance is storing. The bucket name and endpoint are configuration
 * the owner set, not a secret; the keys are never read here.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  const config = readStorageConfig()
  return {
    usage: await storageUsage(),
    configured: isStorageConfigured(),
    bucket: config?.bucket ?? null,
    endpoint: config?.endpoint ?? null
  }
})
