/**
 * ACP retry-state → OutputMessage translation.
 *
 * Grok reports its provider-side retry ladder (rate-limit / 5xx backoff)
 * as `retry_state` updates wrapped in `_x.ai/session_notification`. Without
 * surfacing these, the UI shows a bare "Working" spinner for the entire
 * ladder (up to 15 attempts). Retrying updates share one per-turn message
 * id with `streaming: true` so the renderer upserts a single bubble in
 * place; `exhausted`/recovered messages finalize it with `streaming: false`.
 */

import type { OutputMessage } from '../../../shared/types/instance.types';
import type { AcpRetryStateUpdate } from '../../../shared/types/cli.types';

export function buildRetryStateMessage(update: AcpRetryStateUpdate, messageId: string): OutputMessage {
  const exhausted = update.type === 'exhausted';
  // Reasons carry a multi-line tail ("Request URL: ..."); the first line
  // holds the actionable part (status code + provider guidance).
  const reason = (update.reason ?? '').split('\n', 1)[0].trim();
  const attempt = typeof update.attempt === 'number' ? update.attempt : undefined;
  const maxRetries = typeof update.max_retries === 'number' ? update.max_retries : undefined;

  const attemptSuffix = attempt !== undefined
    ? ` (attempt ${attempt}${maxRetries !== undefined ? `/${maxRetries}` : ''})`
    : '';
  const content = exhausted
    ? `Provider gave up retrying${reason ? `: ${reason}` : '.'}`
    : `Provider hit an error and is retrying${attemptSuffix}${reason ? `: ${reason}` : '.'}`;

  return {
    id: messageId,
    timestamp: Date.now(),
    type: 'system',
    content,
    metadata: {
      transport: 'acp',
      source: 'acp-retry-state',
      sessionUpdate: 'retry_state',
      phase: exhausted ? 'exhausted' : 'retrying',
      streaming: !exhausted,
      accumulatedContent: content,
      ...(attempt !== undefined ? { attempt } : {}),
      ...(maxRetries !== undefined ? { maxRetries } : {}),
    },
  };
}

/**
 * Finalize the retry-state bubble when a turn that reported retries goes on
 * to succeed — otherwise it would read "retrying (attempt N/15)…" forever
 * next to a completed answer.
 */
export function buildRetryRecoveredMessage(messageId: string): OutputMessage {
  const content = 'Provider recovered after retrying.';
  return {
    id: messageId,
    timestamp: Date.now(),
    type: 'system',
    content,
    metadata: {
      transport: 'acp',
      source: 'acp-retry-state',
      sessionUpdate: 'retry_state',
      phase: 'recovered',
      streaming: false,
      accumulatedContent: content,
    },
  };
}
