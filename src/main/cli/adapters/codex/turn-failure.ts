import type { TurnCaptureState } from './app-server-types';
import { extractCodexAppServerError, formatCodexAppServerError, isCodexUsageLimitErrorInfo, type CodexAppServerErrorDetails } from './app-server-errors';
import { CodexAppServerRuntimeError, createCodexUsageLimitError } from './app-server-runtime-errors';

/** Preserve native terminal evidence without changing the send-rejection owner. */
export function createCodexTurnFailure(state: TurnCaptureState, resetAt?: number): Error {
  const details = state.finalTurn?.error != null ? extractCodexAppServerError({ error: state.finalTurn.error }) : undefined;
  return createCodexTerminalError(details, state.error, resetAt);
}

export function createCodexTerminalError(details?: CodexAppServerErrorDetails, captured?: unknown, resetAt?: number): Error {
  const message = details ? formatCodexAppServerError(details)
    : captured instanceof Error ? captured.message : typeof captured === 'string' ? captured : 'Codex turn failed';
  const usageLimit = isCodexUsageLimitErrorInfo(details?.codexErrorInfo)
    || (captured instanceof CodexAppServerRuntimeError && captured.quota !== undefined);
  const error = usageLimit ? createCodexUsageLimitError(message, resetAt)
    : captured instanceof Error && !details ? captured : new Error(message);
  // CodexErrorInfo is camelCase; data-bearing variants carry httpStatusCode.
  let code: unknown = details?.codexErrorInfo;
  try { if (typeof code === 'string') code = JSON.parse(code); } catch { /* Unit variants are unquoted strings. */ }
  const variant = typeof code === 'string' ? code : code && typeof code === 'object' ? Object.keys(code)[0] : undefined;
  const value = code && typeof code === 'object' && variant ? (code as Record<string, unknown>)[variant] : undefined;
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>)['httpStatusCode'] : undefined;
  const errorCodes: Record<string, string> = {
    contextwindowexceeded: 'context_length_exceeded', ratelimitexceeded: 'rate_limit_exceeded',
    serveroverloaded: 'overloaded', internalservererror: 'server_error', unauthorized: 'unauthorized',
    cyberpolicy: 'policy violation', misalignmentpolicyviolation: 'policy violation',
  };
  return Object.assign(error, { willRetry: false,
    ...(variant ? { errorCode: errorCodes[variant.replaceAll('_', '').toLowerCase()] ?? variant } : {}),
    ...(typeof status === 'number' ? { statusCode: status } : {}),
  });
}
