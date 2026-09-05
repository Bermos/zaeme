import { isSetupRequired } from '../../utils/instance'

/** Has anybody claimed this instance yet? Drives `/setup`. Deliberately open. */
export default defineEventHandler(async () => {
  return { setupRequired: await isSetupRequired() }
})
