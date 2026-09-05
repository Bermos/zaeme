import { createHash } from 'node:crypto'
import { OWNER_ID_ENV, SERVICE_TOKEN_ENV } from './service-auth'

/**
 * The state of the Enterprise service credential, WITHOUT the credential.
 *
 * The admin surface has to answer "is the machine API actually wired up, and is
 * the token in my password manager the one this instance is running with?" —
 * and must answer it without ever putting the secret on a page. So it reports a
 * fingerprint: the first 12 hex of the token's SHA-256, which the owner can
 * recompute from their copy (`printf %s "$TOKEN" | sha256sum`) and compare.
 *
 * The Enterprise owner id is NOT a secret — it is an account id in another
 * system, and seeing it is how the owner checks the mapping is the right one —
 * so it is returned in full.
 *
 * There is deliberately no "rotate" button. The token is an environment
 * variable on TWO systems (ADR-0036: "rotate by replacing it in both places at
 * once"); a button that changed it here would only break the pair. Rotation is
 * a deploy, and the fingerprint is how the owner confirms it landed.
 */
export interface ServiceCredentialStatus {
  configured: boolean
  fingerprint: string | null
  ownerIdConfigured: boolean
  enterpriseOwnerId: string | null
}

export function serviceCredentialStatus(): ServiceCredentialStatus {
  const token = process.env[SERVICE_TOKEN_ENV]?.trim()
  const ownerId = process.env[OWNER_ID_ENV]?.trim()
  return {
    configured: Boolean(token),
    fingerprint: token ? createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12) : null,
    ownerIdConfigured: Boolean(ownerId),
    enterpriseOwnerId: ownerId || null
  }
}
