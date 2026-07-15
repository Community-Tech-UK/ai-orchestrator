export type CodexAppServerFailureKind =
  | 'transport-closed'
  | 'request-timeout'
  | 'request-rejected'
  | 'protocol-invalid'
  | 'thread-unavailable'
  | 'turn-stalled'
  | 'turn-failed'
  | 'recovery-paused'
  | 'authentication'
  | 'provider-limit'
  | 'unknown';

export type CodexAppServerRecoverability =
  | 'retry-thread'
  | 'replay-required'
  | 'user-action'
  | 'terminal'
  | 'unknown';

export interface CodexAppServerRuntimeErrorOptions {
  kind: CodexAppServerFailureKind;
  message: string;
  recoverability: CodexAppServerRecoverability;
  cause?: unknown;
  method?: string;
  rpcCode?: number;
}

/** Typed failure crossing the Codex transport/runtime boundary. */
export class CodexAppServerRuntimeError extends Error {
  readonly kind: CodexAppServerFailureKind;
  readonly recoverability: CodexAppServerRecoverability;
  readonly method?: string;
  readonly rpcCode?: number;
  override readonly cause?: unknown;

  constructor(options: CodexAppServerRuntimeErrorOptions) {
    super(options.message);
    this.name = 'CodexAppServerRuntimeError';
    this.kind = options.kind;
    this.recoverability = options.recoverability;
    this.cause = options.cause;
    this.method = options.method;
    this.rpcCode = options.rpcCode;
  }
}

/**
 * Converts legacy/untyped Codex errors once at the runtime boundary. Internal
 * recovery code can then branch on `kind` instead of repeating text regexes.
 */
export function classifyCodexAppServerFailure(error: unknown): CodexAppServerRuntimeError {
  if (error instanceof CodexAppServerRuntimeError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const options = classifyMessage(message);
  return new CodexAppServerRuntimeError({ ...options, message, cause: error });
}

function classifyMessage(message: string): Pick<
  CodexAppServerRuntimeErrorOptions,
  'kind' | 'recoverability'
> {
  if (/context-cost recovery (paused|limit)|recovery paused/i.test(message)) {
    return { kind: 'recovery-paused', recoverability: 'user-action' };
  }
  if (/unauthorized|authentication|forbidden|login required/i.test(message)) {
    return { kind: 'authentication', recoverability: 'terminal' };
  }
  if (/usage limit|rate limit|too many requests|quota/i.test(message)) {
    return { kind: 'provider-limit', recoverability: 'user-action' };
  }
  if (/thread .*(not found|missing|unavailable)|no rollout found|unknown thread/i.test(message)) {
    return { kind: 'thread-unavailable', recoverability: 'replay-required' };
  }
  if (/turn stalled: no notifications received/i.test(message)) {
    return { kind: 'turn-stalled', recoverability: 'retry-thread' };
  }
  if (/rpc timeout|request timed out|did not respond within|\btimeout\b/i.test(message)) {
    return { kind: 'request-timeout', recoverability: 'retry-thread' };
  }
  if (/http 5\d\d|network error|connection (refused|reset|timed out|closed)|socket (closed|hang up)|stream disconnected|responseStreamDisconnected|incomplete response returned|dns|tls|handshake|econnreset|broken pipe/i.test(message)) {
    return { kind: 'transport-closed', recoverability: 'retry-thread' };
  }
  if (/content_filter/i.test(message)) {
    return { kind: 'turn-failed', recoverability: 'retry-thread' };
  }
  if (/unknown model|model not found|invalid model/i.test(message)) {
    return { kind: 'request-rejected', recoverability: 'terminal' };
  }
  if (/turn failed/i.test(message)) {
    return { kind: 'turn-failed', recoverability: 'retry-thread' };
  }
  return { kind: 'unknown', recoverability: 'unknown' };
}
