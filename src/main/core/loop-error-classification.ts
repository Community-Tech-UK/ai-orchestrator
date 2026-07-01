import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { FailoverError, type FailoverReason } from './failover-error';

export interface LoopErrorClassificationContext {
  readonly provider?: string;
  readonly model?: string;
  readonly instanceId?: string;
  readonly status?: number;
  readonly statusCode?: number;
  readonly code?: string | number;
  readonly headers?: Record<string, string | readonly string[] | undefined>;
  readonly body?: unknown;
}

export interface LoopErrorClassification {
  readonly reason: FailoverReason;
  readonly category: ErrorCategory;
  readonly axes: {
    readonly retryable: boolean;
    readonly shouldCompress: boolean;
    readonly shouldFailover: boolean;
    readonly rotateCredential: boolean;
  };
  readonly retryAfterMs: number | null;
  readonly serverWindowTokens?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly instanceId?: string;
  readonly status?: number;
  readonly code?: string | number;
  readonly message: string;
}

interface ErrorFacts {
  readonly message: string;
  readonly bodyText: string;
  readonly combinedText: string;
  readonly status?: number;
  readonly code?: string | number;
  readonly headers?: Record<string, string | readonly string[] | undefined>;
  readonly provider?: string;
  readonly model?: string;
  readonly instanceId?: string;
}

const RETRYABLE_REASONS = new Set<FailoverReason>([
  'rate_limit',
  'timeout',
  'process_exit',
  'provider_runtime',
  'prompt_delivery',
  'tool_runtime',
  'session_resume',
]);

const UNSUPPORTED_MAX_TOKENS_RE = /unsupported\s+parameter\s*:?\s*max_tokens|max_tokens[^.]{0,80}unsupported/i;
const CONTEXT_OVERFLOW_RE = /context(?:\s+window|\s+length)?[^.]{0,80}(?:exceed|overflow|too\s+long)|context_length_exceeded|maximum\s+context\s+length|too\s+many\s+tokens|token(?:s)?\s+limit/i;
const RATE_LIMIT_RE = /rate.?limit|too.?many.?requests|throttl|usage\s+limit|quota[^.]{0,80}(?:reset|exceed|limit)|resets?\s+at/i;
const AUTH_RE = /auth|unauthorized|forbidden|invalid.?api.?key|invalid.?key/i;
const BILLING_RE = /billing|payment\s+required|insufficient.?funds|credits?\s+exhausted/i;
const TIMEOUT_RE = /timeout|timed?.?out|deadline/i;
const PROVIDER_RUNTIME_RE = /provider runtime|provider adapter|adapter.*failed|provider unavailable|model provider failed/i;
const PROMPT_DELIVERY_RE = /failed to deliver prompt|failed to send (?:input|message)|prompt delivery|broken pipe|EPIPE/i;
const STALE_WORKTREE_RE = /stale worktree|dirty worktree|merge conflict|needs rebase|branch .* behind|worktree .* locked/i;
const TOOL_RUNTIME_RE = /tool runtime|tool execution failed|tool .* failed|command exited with code|subprocess failed/i;
const SAFETY_REFUSAL_RE = /safety[^.]{0,80}(?:policy|refus|block|disallow)|refus(?:ed|al)[^.]{0,80}(?:safety|policy)|disallowed content/i;
const PERMISSION_RE = /approval required|permission required|sandbox denied|denied by policy|user rejected|EACCES|EPERM/i;
const SESSION_RESUME_RE = /resume failed|failed to resume|session replay|checkpoint restore failed|history recovery failed/i;
const VALIDATION_RE = /validation failed|invalid payload|schema|zod|expected .* received|bad request|invalid_request/i;
const PROCESS_EXIT_RE = /exit.*(?:code|status)|process.*(?:died|exited|terminated)|spawn.*error|ENOENT|SIGKILL|SIGTERM/i;

export function classifyLoopError(
  err: unknown,
  context: LoopErrorClassificationContext = {},
): LoopErrorClassification {
  const facts = extractErrorFacts(err, context);
  const safetyRefusal = SAFETY_REFUSAL_RE.test(facts.combinedText);
  const reason = determineReason(err, facts, safetyRefusal);
  const category = categoryFor(reason, facts);
  const shouldCompress = reason === 'context_overflow';
  const retryAfterMs = parseServerRetryAfterMs(facts.headers, facts.combinedText);
  const retryable = !shouldCompress && (
    RETRYABLE_REASONS.has(reason) ||
    category === ErrorCategory.TRANSIENT ||
    category === ErrorCategory.RATE_LIMITED
  );
  const rotateCredential = reason === 'auth' || reason === 'billing' || isCredentialQuotaLimit(reason, facts);
  const shouldFailover = shouldFailoverFor(reason, category, safetyRefusal);
  const serverWindowTokens = shouldCompress ? extractServerWindowTokens(facts.combinedText) : undefined;

  return {
    reason,
    category,
    axes: {
      retryable,
      shouldCompress,
      shouldFailover,
      rotateCredential,
    },
    retryAfterMs,
    ...(serverWindowTokens !== undefined ? { serverWindowTokens } : {}),
    ...(facts.provider ? { provider: facts.provider } : {}),
    ...(facts.model ? { model: facts.model } : {}),
    ...(facts.instanceId ? { instanceId: facts.instanceId } : {}),
    ...(facts.status !== undefined ? { status: facts.status } : {}),
    ...(facts.code !== undefined ? { code: facts.code } : {}),
    message: facts.message,
  };
}

function determineReason(err: unknown, facts: ErrorFacts, safetyRefusal: boolean): FailoverReason {
  if (err instanceof FailoverError) return err.reason;
  if (UNSUPPORTED_MAX_TOKENS_RE.test(facts.combinedText)) return 'validation';
  if (CONTEXT_OVERFLOW_RE.test(facts.combinedText)) return 'context_overflow';
  if (facts.status === 429 || RATE_LIMIT_RE.test(facts.combinedText) || isResetWindowPaymentRequired(facts)) {
    return 'rate_limit';
  }
  if (facts.status === 401 || facts.status === 403 || AUTH_RE.test(facts.combinedText)) return 'auth';
  if (facts.status === 402 || BILLING_RE.test(facts.combinedText)) return 'billing';
  if (TIMEOUT_RE.test(facts.combinedText)) return 'timeout';
  if (PROMPT_DELIVERY_RE.test(facts.combinedText)) return 'prompt_delivery';
  if (SESSION_RESUME_RE.test(facts.combinedText)) return 'session_resume';
  if (TOOL_RUNTIME_RE.test(facts.combinedText)) return 'tool_runtime';
  if (PROVIDER_RUNTIME_RE.test(facts.combinedText)) return 'provider_runtime';
  if (STALE_WORKTREE_RE.test(facts.combinedText)) return 'stale_worktree';
  if (safetyRefusal || PERMISSION_RE.test(facts.combinedText)) return 'permission';
  if (VALIDATION_RE.test(facts.combinedText) || facts.status === 400) return 'validation';
  if (PROCESS_EXIT_RE.test(facts.combinedText)) return 'process_exit';
  return 'unknown';
}

function categoryFor(reason: FailoverReason, facts: ErrorFacts): ErrorCategory {
  switch (reason) {
    case 'rate_limit':
      return ErrorCategory.RATE_LIMITED;
    case 'auth':
    case 'billing':
      return ErrorCategory.AUTH;
    case 'context_overflow':
      return ErrorCategory.RESOURCE;
    case 'timeout':
    case 'process_exit':
      return ErrorCategory.TRANSIENT;
    case 'provider_runtime':
      return ErrorCategory.PROVIDER_RUNTIME;
    case 'prompt_delivery':
      return ErrorCategory.PROMPT_DELIVERY;
    case 'tool_runtime':
      return ErrorCategory.TOOL_RUNTIME;
    case 'permission':
      return ErrorCategory.PERMISSION;
    case 'session_resume':
      return ErrorCategory.SESSION_RESUME;
    case 'validation':
      return ErrorCategory.VALIDATION;
    case 'stale_worktree':
      return ErrorCategory.STALE_WORKTREE;
    case 'unknown':
      return facts.status !== undefined && facts.status >= 500 && facts.status <= 599
        ? ErrorCategory.TRANSIENT
        : ErrorCategory.UNKNOWN;
  }
}

function shouldFailoverFor(reason: FailoverReason, category: ErrorCategory, safetyRefusal: boolean): boolean {
  return safetyRefusal ||
    reason === 'rate_limit' ||
    reason === 'billing' ||
    reason === 'auth' ||
    reason === 'provider_runtime' ||
    reason === 'prompt_delivery' ||
    category === ErrorCategory.PROVIDER_RUNTIME ||
    category === ErrorCategory.PROMPT_DELIVERY;
}

function isCredentialQuotaLimit(reason: FailoverReason, facts: ErrorFacts): boolean {
  return reason === 'rate_limit' && (
    facts.status === 402 ||
    /quota|usage\s+limit|billing|payment|credits?/i.test(facts.combinedText)
  );
}

function isResetWindowPaymentRequired(facts: ErrorFacts): boolean {
  return facts.status === 402 && /reset|quota|usage\s+limit|rate.?limit/i.test(facts.combinedText);
}

function extractErrorFacts(err: unknown, context: LoopErrorClassificationContext): ErrorFacts {
  const error = err instanceof Error ? err : new Error(String(err));
  const shaped = error as Error & {
    status?: number;
    statusCode?: number;
    code?: string | number;
    headers?: Record<string, string | readonly string[] | undefined>;
    body?: unknown;
    response?: {
      status?: number;
      statusCode?: number;
      headers?: Record<string, string | readonly string[] | undefined>;
      body?: unknown;
      data?: unknown;
    };
    provider?: string;
    model?: string;
    instanceId?: string;
  };
  const body = context.body ?? shaped.body ?? shaped.response?.body ?? shaped.response?.data;
  const bodyText = stringifyBody(body);
  const message = error.message || String(err);

  return {
    message,
    bodyText,
    combinedText: `${message}\n${bodyText}`,
    status: context.status ?? context.statusCode ?? shaped.status ?? shaped.statusCode ?? shaped.response?.status ?? shaped.response?.statusCode,
    code: context.code ?? shaped.code,
    headers: context.headers ?? shaped.headers ?? shaped.response?.headers,
    provider: context.provider ?? shaped.provider ?? (err instanceof FailoverError ? err.provider : undefined),
    model: context.model ?? shaped.model ?? (err instanceof FailoverError ? err.model : undefined),
    instanceId: context.instanceId ?? shaped.instanceId ?? (err instanceof FailoverError ? err.instanceId : undefined),
  };
}

function stringifyBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'number' || typeof body === 'boolean') return String(body);
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function headerValue(headers: ErrorFacts['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerName || value === undefined) continue;
    return typeof value === 'string' ? value : value[0];
  }
  return undefined;
}

function parseServerRetryAfterMs(headers: ErrorFacts['headers'], text: string): number | null {
  const retryAfter = parseRetryAfterHeaderMs(headerValue(headers, 'retry-after'));
  if (retryAfter !== null) return retryAfter;
  const resetHeader = parseRateLimitResetMs(headerValue(headers, 'x-ratelimit-reset'));
  if (resetHeader !== null) return resetHeader;
  return parseResetTimestampFromText(text);
}

function parseRetryAfterHeaderMs(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(trimmed);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function parseRateLimitResetMs(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const epochMs = numeric > 1_000_000_000_000
    ? numeric
    : numeric > 1_000_000_000
      ? numeric * 1000
      : Date.now() + numeric * 1000;
  return Math.max(0, epochMs - Date.now());
}

function parseResetTimestampFromText(text: string): number | null {
  const match = /\breset(?:s)?\s+at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[^\s.,;]+)/i.exec(text);
  if (!match?.[1]) return null;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : null;
}

function extractServerWindowTokens(text: string): number | undefined {
  const patterns = [
    /maximum\s+context\s+length\s+is\s+([\d,]+)\s+tokens/i,
    /context\s+window(?:\s+size)?(?:\s+is|:)?\s+([\d,]+)\s+tokens/i,
    /\b([\d,]+)\s+token\s+context\s+window/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const parsed = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
