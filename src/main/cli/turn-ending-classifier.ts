import type { ProviderTurnEndingReason, TurnEndingClassification } from '@contracts/types/provider-runtime-events';
import { hasCollapsedReasoning } from './adapters/reasoning-collapse';
import { isContentFilterEnding } from './adapters/content-filter-ending';
import { findTrailingProviderRefusal, findTrailingTransportFailure } from './transport-failure';

export type { ProviderTurnEndingReason, TurnEndingClassification } from '@contracts/types/provider-runtime-events';

export interface TurnEndingInput {
  kind: 'complete' | 'error';
  text?: string;
  metadata?: unknown;
  raw?: unknown;
  thinking?: readonly { content: string }[];
  outputTokens?: number;
  reasoningTokens?: number;
  hasOpenToolCall?: boolean;
  lastToolReadLike?: boolean;
  cancelled?: boolean;
  error?: unknown;
  /** Combined output+reasoning cap the runtime injected for this turn. */
  combinedOutputTokenCap?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Native terminal fields, never arbitrary nested tool inputs or source text. */
export function readTurnEndingMetadata(metadata: unknown, raw?: unknown): Record<string, unknown> {
  const frames = typeof raw === 'string' ? raw.split('\n').flatMap((line) => {
    if (!line.trimStart().startsWith('{')) return [];
    try { return [record(JSON.parse(line))]; } catch { return []; }
  }) : Array.isArray(raw) ? raw.map(record) : [record(raw)];
  const native: Record<string, unknown> = {};
  for (const frame of frames) {
    // Claude child messages share stdout with the parent. A child stop does
    // not end the parent's turn and must never replace its terminal fields.
    if (frame['parent_tool_use_id']) continue;
    const type = frame['type'];
    if (type && !['result', 'assistant', 'turn.completed', 'turn.failed', 'error', 'session.error', 'assistant.message', 'assistant.turn_end'].includes(String(type))) continue;
    for (const candidate of [frame, record(frame['message']), record(frame['data']), record(frame['error'])]) {
      for (const key of ['stopReason', 'stop_reason', 'finish', 'finishReason', 'finish_reason', 'is_error', 'api_error_status', 'code', 'status']) {
        if (candidate[key] !== undefined && candidate[key] !== null) native[key] = candidate[key];
      }
      if (candidate['error'] || type === 'turn.failed' || type === 'session.error') native['is_error'] = true;
      if (candidate['is_error'] === true || type === 'turn.failed' || type === 'session.error' || type === 'error') {
        const message = candidate['message'] ?? candidate['result'];
        if (typeof message === 'string') native['errorMessage'] = message;
      }
    }
  }
  return { ...native, ...record(metadata) };
}

export function classifyTurnEnding(input: TurnEndingInput): TurnEndingClassification {
  const meta = readTurnEndingMetadata(input.metadata, input.raw);
  const native = [meta['stopReason'], meta['stop_reason'], meta['finish'], meta['finishReason'], meta['finish_reason']]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase().replace(/[- ]/g, '_'));
  const providerRetrying = meta['providerRetrying'] === true || meta['retrying'] === true || meta['willRetry'] === true || meta['will_retry'] === true;
  const cancelled = input.cancelled || meta['cancelled'] === true || native.some((reason) => ['cancelled', 'canceled', 'interrupted'].includes(reason));
  const suppression = providerRetrying ? { providerRetrying: true, autoContinueSuppressed: true } : {};
  const result = (reason: ProviderTurnEndingReason, evidence: string, extras: Partial<TurnEndingClassification> = {}): TurnEndingClassification =>
    ({ reason, evidence, ...extras, ...suppression });
  if (cancelled) return result('completed', 'client_cancelled', { autoContinueSuppressed: true });

  const errorRecord = record(input.error);
  const errorText = input.error instanceof Error ? input.error.message : typeof input.error === 'string' ? input.error : typeof errorRecord['message'] === 'string' ? errorRecord['message'] : '';
  const failureText = [errorText, meta['errorMessage'], meta['error'], meta['errorCode'], meta['code']].filter((value): value is string => typeof value === 'string').join(' ');
  const status = Number(meta['api_error_status'] ?? meta['statusCode'] ?? meta['httpStatus'] ?? errorRecord['statusCode'] ?? errorRecord['status'] ?? meta['status'] ?? errorRecord['code']);
  if (status === 401 || status === 403 || /\b(?:unauthorized|authentication failed|authentication required|invalid api key|not authenticated|login required|token expired)\b/i.test(failureText)) return result('auth', 'provider_auth_error');
  if (/\b(?:billing|insufficient credits|payment required|credit balance)\b/i.test(failureText) || status === 402) return result('billing', 'provider_billing_error');
  if (native.includes('model_context_window_exceeded') || /\b(?:context_length_exceeded|context window exceeded|context overflow|prompt too long|prompt_too_long|request too large)\b/i.test(failureText)) return result('context_overflow', 'provider_context_error');
  if (record(meta['quota'])['exhausted'] === true || status === 429 || /\b(?:quota exceeded|rate limit|rate_limit_exceeded|usage limit|resource_exhausted)\b/i.test(failureText)) return result('quota', 'provider_quota_error');
  if (native.some((reason) => ['refusal', 'content_filter', 'content_filtered'].includes(reason)) || /\b(?:ContentFilterError|content_filter|content filter|policy violation|safety policy)\b/i.test(failureText) || meta['contentFilterBlocked'] === true || isContentFilterEnding(input.text ?? '')) {
    return result('content_filter', native.includes('refusal') || native.includes('content_filter') ? 'native_content_filter' : 'content_filter_fallback', { ...(input.lastToolReadLike || meta['contentFilterFromTool'] === true ? { contentFilterFromTool: true } : {}) });
  }
  if (meta['doomLoop'] === true || /\bdoom[_ ]loop\b/i.test(failureText)) return result('doom_loop', 'provider_doom_loop');
  if (meta['parentSilent'] === true || errorRecord['parentSilent'] === true) return result('parent_silent', 'delegated_task_lease_expired');
  if (meta['crash'] === true || /\b(?:ACP agent exited|process exited|socket closed|connection closed unexpectedly)\b/i.test(failureText)) return result('crash', 'provider_process_exit');
  if (meta['transportFailure'] || findTrailingTransportFailure(input.text)) return result('truncated_transport', 'transport_failure');
  if (input.kind === 'error' && /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|stream closed)\b/i.test(failureText)) return result('truncated_transport', 'transport_error');
  if (meta['providerRefusal'] || findTrailingProviderRefusal(input.text)) return result('quota', 'trailing_provider_refusal');

  const nativeRepetition = native.includes('repetition_truncation');
  const reasoningCollapsed = nativeRepetition || meta['reasoningCollapsed'] === true || hasCollapsedReasoning(input.thinking);
  const visibleAnswerComplete = reasoningCollapsed && (input.outputTokens ?? Number(meta['outputTokens'])) > 0
    && !input.hasOpenToolCall && meta['hasOpenToolCall'] !== true && /[.!?][\s"')\]]*$/.test((input.text ?? '').trim())
    && !/\b(?:continue|continuing|next I(?:'ll| will)|I(?:'ll| will))[^.!?]*[.!?]$/i.test((input.text ?? '').trim());
  if (native.some((reason) => ['max_tokens', 'max_output_tokens', 'length'].includes(reason)) || reasoningCollapsed) {
    return result('max_output', nativeRepetition ? 'native_repetition_truncation' : reasoningCollapsed ? 'collapsed_reasoning' : 'native_max_output', {
      ...(reasoningCollapsed ? { reasoningCollapsed: true } : {}),
      ...(visibleAnswerComplete ? { visibleAnswerComplete: true, autoContinueSuppressed: true } : {}),
    });
  }
  if (native.some((reason) => ['tool_calls', 'tool_use', 'pause_turn', 'tool_deferred'].includes(reason))) return result('completed', 'provider_tool_boundary', { autoContinueSuppressed: true });
  if (meta['danglingToolResult'] === true && meta['toolResultAwaitingReply'] === true && !input.hasOpenToolCall) return result('dangling_tool_result', 'explicit_unanswered_tool_result');
  if ([502, 503, 504].includes(Number(status)) || /\b(?:overloaded|server_error|temporarily unavailable|retryable recovery|retrying)\b/i.test(failureText)) return result('retryable', 'provider_transient_error');
  const userStopped = (meta['is_error'] === true || input.kind === 'error')
    && /\b(?:interrupted by (?:the )?user|user interrupted)\b/i.test(failureText);
  if (userStopped) return result('completed', 'client_cancelled', { autoContinueSuppressed: true });
  if (outputBudgetSaturated(input)) return result('max_output', 'budget_saturated');
  if (input.kind === 'error' || native.includes('error') || meta['is_error'] === true || meta['error'] || meta['completionStatus'] === 'failed') return result('unknown_error', 'provider_error');
  return result('completed', 'provider_completed');
}

/** A scoped cap was reached and the visible answer is not a finished sentence. */
function outputBudgetSaturated(input: TurnEndingInput): boolean {
  const cap = input.combinedOutputTokenCap;
  if (cap === undefined || cap <= 0 || input.hasOpenToolCall) return false;
  const used = (input.outputTokens ?? 0) + (input.reasoningTokens ?? 0);
  const tolerance = Math.min(64, Math.max(8, Math.floor(cap * 0.02)));
  if (used + tolerance < cap) return false;
  const text = (input.text ?? '').trim();
  if (!text) return false;
  return !/[.!?][\s"')\]]*$/.test(text);
}
