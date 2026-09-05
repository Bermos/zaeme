import { defineV1Handler } from '#server/utils/api-v1'

/**
 * `getHealth` — the ONE unauthenticated operation in the contract
 * (`security: []`). Enterprise's shim uses it for its circuit breaker, never as
 * a precondition for a call, so it deliberately says nothing about the
 * database: `/healthz` is the readiness probe that does that.
 */
export default defineV1Handler(async () => ({
  ok: true as const,
  version: process.env.KITCHEN_RELEASE || process.env.GIT_SHA || 'dev'
}))
