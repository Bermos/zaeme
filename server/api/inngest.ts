import { serve } from 'inngest/nuxt'
import { inngest } from '../inngest/client'
import { functions } from '../inngest/index'

/**
 * The Inngest serve endpoint: Inngest calls it to discover the registered
 * functions and to deliver runs (including the 48h reminder, scheduled with a
 * future `ts`). The SDK reads `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY`
 * from the environment; with neither set it falls back to the dev server.
 */
export default defineEventHandler(
  serve({
    client: inngest,
    functions
  })
)
