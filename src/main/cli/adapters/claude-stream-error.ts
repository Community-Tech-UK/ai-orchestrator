import { asUnknownRecord } from './claude-cli-adapter.types';
import { ProviderAuthenticationError } from './provider-authentication-error';

const CLAUDE_AUTH_ERROR_CODES = new Set([
  'authentication_failed',
]);

export interface ClaudeStreamError {
  error: Error;
  authoritativeAuthFailure: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function firstTextBlock(event: Record<string, unknown>): string | undefined {
  const message = event['message'];
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const text = stringValue((block as Record<string, unknown>)['text']);
    if (text) return text;
  }
  return undefined;
}

/**
 * Converts Claude stream error shapes into real adapter errors.
 *
 * Claude currently reports OAuth refresh failure as an `assistant` event with
 * `error: "authentication_failed"` and `isApiErrorMessage: true`. Older/error
 * paths use `type: "error"` with an `{ code, message }` object. Both must reach
 * the adapter error channel; ordinary assistant prose must not.
 */
export function parseClaudeStreamError(
  event: unknown,
): ClaudeStreamError | null {
  const record = asUnknownRecord(event);
  if (!record) return null;
  const rawError = record['error'];
  const errorObject = rawError && typeof rawError === 'object'
    ? rawError as Record<string, unknown>
    : null;
  const code = stringValue(rawError) ?? stringValue(errorObject?.['code']);
  const message = firstTextBlock(record)
    ?? stringValue(errorObject?.['message'])
    ?? stringValue(record['content']);
  const authoritativeAuthFailure = Boolean(code && CLAUDE_AUTH_ERROR_CODES.has(code));

  if (authoritativeAuthFailure) {
    return {
      error: new ProviderAuthenticationError(
        message ?? 'Claude authentication failed',
        code,
      ),
      authoritativeAuthFailure: true,
    };
  }

  if (record['type'] === 'error' && message) {
    return { error: new Error(message), authoritativeAuthFailure: false };
  }

  return null;
}
