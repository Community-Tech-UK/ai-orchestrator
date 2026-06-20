/**
 * Resume Error Classifier
 *
 * Single source of truth for session/thread/conversation-not-found patterns.
 * Previously these regexes were duplicated across at least six files:
 *   - instance-communication-adapter-helpers.ts
 *   - history-restore-helpers.ts
 *   - history-manager.ts
 *   - cursor-cli-adapter.ts
 *   - codex-cli-adapter.ts
 *   - instance/lifecycle/runtime-readiness.ts
 *   - cli/adapters/codex/exec-diagnostics.ts
 *
 * All callers should import from here.  The classifier is provider-agnostic —
 * it returns a structured result rather than a bare boolean so callers can
 * decide on blacklisting vs retry vs immediate fallback.
 */

/** The category of resume failure detected in a message or error. */
export type ResumeErrorKind =
  /** The session / conversation / thread id was not found by the provider. */
  | 'not-found'
  /** The session exists but has expired (provider-side TTL). */
  | 'expired'
  /** The session id is syntactically invalid or rejected outright. */
  | 'invalid'
  /** A thread-level id (Codex thread_id) was not found. */
  | 'thread-not-found'
  /** Unknown / unclassified resume failure. */
  | 'unknown';

export interface ResumeErrorClassification {
  /** Whether the content looks like a definitive resume failure. */
  isResumeFailure: boolean;
  /** Specific failure category, useful for blacklisting policy. */
  kind: ResumeErrorKind;
  /**
   * Whether this failure is definitive (blacklist the id immediately) vs
   * transient (retry once before falling back).
   */
  isDefinitive: boolean;
}

const NOT_FOUND_PATTERN = new RegExp(
  [
    'no conversation found',
    'conversation not found',
    'session not found',
    'unknown session',
    'no such session',
    'session does not exist',
    'missing session',
    'no matching session',
  ].join('|'),
  'i',
);

const THREAD_NOT_FOUND_PATTERN = new RegExp(
  [
    'thread not found',
    'unknown thread',
    'no such thread',
    'thread does not exist',
    'no rollout found',
    'missing rollout',
  ].join('|'),
  'i',
);

const EXPIRED_PATTERN = new RegExp(
  [
    'session expired',
    'expired session',
    'session has expired',
    'conversation expired',
  ].join('|'),
  'i',
);

const INVALID_PATTERN = new RegExp(
  [
    'invalid session id',
    'invalid session',
    'invalid thread',
    'bad session',
  ].join('|'),
  'i',
);

/**
 * Classify a message or error text as a resume failure.
 *
 * Returns `{ isResumeFailure: false }` when the text is unrelated to
 * session/thread identity.
 */
export function classifyResumeError(text: string): ResumeErrorClassification {
  const lower = text.toLowerCase();

  if (THREAD_NOT_FOUND_PATTERN.test(lower)) {
    return { isResumeFailure: true, kind: 'thread-not-found', isDefinitive: true };
  }
  if (NOT_FOUND_PATTERN.test(lower)) {
    return { isResumeFailure: true, kind: 'not-found', isDefinitive: true };
  }
  if (EXPIRED_PATTERN.test(lower)) {
    return { isResumeFailure: true, kind: 'expired', isDefinitive: true };
  }
  if (INVALID_PATTERN.test(lower)) {
    return { isResumeFailure: true, kind: 'invalid', isDefinitive: true };
  }

  return { isResumeFailure: false, kind: 'unknown', isDefinitive: false };
}

/**
 * Convenience predicate — returns true when the text contains a definitive
 * session/thread-not-found signal.  Replaces `isSessionNotFoundMessage()` in
 * instance-communication-adapter-helpers, history-restore-helpers,
 * runtime-readiness, etc.
 */
export function isSessionNotFoundText(text: string): boolean {
  const result = classifyResumeError(text);
  return result.isResumeFailure && result.isDefinitive;
}
