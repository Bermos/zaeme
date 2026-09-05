import { machineActivity } from '../../domain/index'
import { requireOwner, serviceCredentialStatus } from '../../utils/admin'
import { resolveInstancePlanner } from '../../utils/instance'

/**
 * The Enterprise link (ADR-0036): is the service credential configured, which
 * Enterprise owner it is mapped to, who zäme resolves that owner to locally,
 * and whether Enterprise has actually been calling.
 *
 * The token itself never leaves the process — only a fingerprint of it, see
 * `serviceCredentialStatus`.
 */
export default defineEventHandler(async (e) => {
  await requireOwner(e)
  return {
    credential: serviceCredentialStatus(),
    planner: await resolveInstancePlanner(),
    activity: await machineActivity(30),
    contractUrl: '/api/openapi.yaml'
  }
})
