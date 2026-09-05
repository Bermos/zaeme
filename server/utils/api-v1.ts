import { H3Error, getRequestHeader, setResponseStatus, type H3Event } from 'h3'
import { ZodError } from 'zod'
import { createId } from '@paralleldrive/cuid2'

/**
 * The `/api/v1` machine surface — error envelope, handler wrapper and the
 * mapping from domain exceptions onto the contract's stable codes.
 *
 * Everything here exists because `docs/zaeme-api.openapi.yaml` promises ONE
 * error shape (`components.schemas.Error`) for every non-2xx answer, and h3's
 * default error body is not it. Rather than hand-rolling that envelope in
 * forty handlers — or installing a global error hook that would also rewrite
 * the guest surface's errors — every `/api/v1` route is wrapped in
 * `defineV1Handler`, which owns the translation in one place.
 *
 * The domain throws h3 errors with plain HTTP status codes (`404` no such
 * event, `403` not a planner, `422` "you cannot do that from this status").
 * `codeForStatus` maps those onto the contract's machine codes. The one case
 * that needs a hint is `invalid_transition`: the domain raises a 422 for it,
 * but the contract says 409, so the three lifecycle routes wrap their call in
 * `asInvalidTransition()` instead of guessing from the message text.
 */

/** The stable machine codes from the contract's `Error.code` enum. */
export type ApiErrorCode
  = | 'unauthenticated'
    | 'forbidden'
    | 'not_found'
    | 'validation_failed'
    | 'invalid_transition'
    | 'conflict'
    | 'payload_too_large'
    | 'unsupported_media_type'
    | 'rate_limited'
    | 'internal'

export interface ApiErrorBody {
  error: { code: ApiErrorCode, message: string, details?: Record<string, unknown> }
  requestId?: string
}

/** An error already carrying a contract code — thrown directly by handlers. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function apiError(
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApiError {
  return new ApiError(statusCode, code, message, details)
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'validation_failed',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'not_found',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited'
}

function codeForStatus(status: number): ApiErrorCode {
  return STATUS_CODES[status] ?? 'internal'
}

/**
 * Run `fn`, and re-raise a domain 422 as the contract's 409
 * `invalid_transition`. The domain says "Cannot transition from draft to
 * completed" with a 422; the contract reserves 409 for exactly that, with the
 * current status in `error.details.from`. Only the lifecycle operations that
 * declare a 409 use this.
 */
export async function asInvalidTransition<T>(
  fn: () => Promise<T>,
  details: Record<string, unknown>
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof H3Error && err.statusCode === 422) {
      throw apiError(409, 'invalid_transition', err.message, details)
    }
    throw err
  }
}

/** Normalise anything thrown inside a handler into `{ status, body }`. */
export function toErrorBody(err: unknown, requestId: string): { status: number, body: ApiErrorBody } {
  if (err instanceof ApiError) {
    return {
      status: err.statusCode,
      body: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }, requestId }
    }
  }

  if (err instanceof ZodError) {
    const details: Record<string, unknown> = {}
    for (const issue of err.issues) {
      details[issue.path.join('.') || '(body)'] = issue.message
    }
    return {
      status: 422,
      body: { error: { code: 'validation_failed', message: 'The request body failed validation.', details }, requestId }
    }
  }

  if (err instanceof H3Error) {
    // h3 wraps a thrown ZodError from `readValidatedBody` in a 400 with the
    // issues on `.data`; unwrap it so the caller sees field-level detail.
    const cause = err.cause
    if (cause instanceof ZodError) return toErrorBody(cause, requestId)
    const status = err.statusCode || 500
    return {
      status,
      body: {
        error: {
          code: codeForStatus(status),
          message: err.message || err.statusMessage || 'Request failed.',
          ...(err.data && typeof err.data === 'object' ? { details: err.data as Record<string, unknown> } : {})
        },
        requestId
      }
    }
  }

  console.error('[api/v1] unhandled', { requestId, err })
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'zäme failed to handle this request.' }, requestId }
  }
}

/**
 * Wrap a `/api/v1` handler so that every failure leaves as the contract's
 * error envelope with the right status. Handlers stay thin: they validate,
 * call a `server/domain` function, and shape the result.
 *
 * NOTE: this deliberately never touches the better-auth session. The machine
 * surface is authenticated by service token ONLY (`server/utils/service-auth`),
 * and a guest cookie must not be a way in — see `test/api-boundary.test.ts`.
 */
export function defineV1Handler<T>(handler: (event: H3Event) => Promise<T>) {
  return defineEventHandler(async (event) => {
    const requestId = getRequestHeader(event, 'x-request-id') || createId()
    try {
      return await handler(event)
    } catch (err) {
      const { status, body } = toErrorBody(err, requestId)
      setResponseStatus(event, status)
      return body
    }
  })
}
