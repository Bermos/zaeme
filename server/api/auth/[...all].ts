import { auth } from '../../utils/auth'

/**
 * zäme's better-auth surface — magic-link request/verify, get-session,
 * sign-out — under `/api/auth/**`. This is the SOCIAL app's own multi-user
 * instance over `zaeme_*` tables (ADR-0019 §3), not the owner's.
 */
export default defineEventHandler(event => auth.handler(toWebRequest(event)))
