/**
 * The ways a call to Linear's connector can fail, as one error class with a `code` the caller can tell apart.
 *
 * `message` is always fixed words written by Harness. Anything the connector said goes in `detail`, redacted and cut
 * short; `detail` may hold text from Linear, so it is for logs and the page, and never for a run's reason (sessions
 * can read a run's reason).
 */

export type LinearFailureCode =
  /** No Linear connection has been confirmed on the Plan Queue page. */
  | 'not-set-up'
  /** The saved connector is gone, turned off, or is no longer Linear's address. */
  | 'connector-unavailable'
  /** The connector's sign-in is missing, expired or was taken away. */
  | 'needs-sign-in'
  /** Linear could not be reached, timed out, or is limiting requests. */
  | 'unreachable'
  /** Linear answered, but not with what Harness reads. */
  | 'unexpected-result';

/** Why a connector is no longer usable as Linear's. */
export type LinearConnectorProblem = 'gone' | 'off' | 'not-linear' | 'read-only';

export interface LinearCallErrorOptions {
  connectorProblem?: LinearConnectorProblem;
  /** Linear is limiting requests. Only set on `unreachable`. */
  rateLimited?: boolean;
  /** The wait Linear asked for, in milliseconds, when it said. */
  retryAfterMs?: number;
  /** Redacted text from the connector, at most 500 characters. May hold Linear's words. */
  detail?: string;
  cause?: unknown;
}

export class LinearCallError extends Error {
  readonly connectorProblem?: LinearConnectorProblem;
  readonly rateLimited: boolean;
  readonly retryAfterMs?: number;
  readonly detail?: string;

  constructor(
    readonly code: LinearFailureCode,
    message: string,
    options: LinearCallErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LinearCallError';
    this.connectorProblem = options.connectorProblem;
    this.rateLimited = options.rateLimited ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }
}

export function isLinearCallError(error: unknown): error is LinearCallError {
  return error instanceof LinearCallError;
}
