import { serve } from 'inngest/nuxt'
import { inngest } from '#server/inngest/client'
import { functions } from '#server/inngest/index'

/**
 * Inngest webhook / dev-server handler. Inngest invokes this endpoint to
 * discover registered functions and to deliver scheduled runs. The SDK
 * reads `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY` from the environment.
 */
export default defineEventHandler(
  serve({
    client: inngest,
    functions
  })
)
