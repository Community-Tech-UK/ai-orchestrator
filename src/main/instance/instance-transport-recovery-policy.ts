import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

export const TRANSPORT_RECOVERY_DELAYS_MS = [2_000, 5_000] as const;
export const TRANSPORT_RECOVERY_PROMPT = [
  'Resume the existing task after the provider connection was interrupted.',
  'Inspect the latest tool results and current files to establish what already completed.',
  'Continue from the first unfinished step, preserving completed work and avoiding duplicate actions.',
  'Keep the original scope and approval requirements. If the task is already complete, report its verified result.',
].join(' ');

// Only the captured Cursor serializer shape is eligible for automatic action.
// The broad trailing-error classifier is intentionally only a notice detector.
const CURSOR_HTTP2_CANCEL =
  'Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Require the captured provider, adapter diagnosis, stop reason, and missing
 * measured usage together. Never recover from transcript fallback or arbitrary
 * error prose. This is deliberately narrower than informational detection. */
export function isRecoverableTransportCompletion(envelope: ProviderRuntimeEventEnvelope): boolean {
  if (envelope.provider !== 'cursor' || envelope.raw?.source !== 'adapter-event:complete') return false;
  const payload = record(envelope.raw.payload);
  const metadata = record(payload?.['metadata']);
  if (
    metadata?.['truncatedTurn'] !== true
    || metadata['transportFailure'] !== CURSOR_HTTP2_CANCEL
    || metadata['stopReason'] !== 'end_turn'
    || record(payload?.['usage'])?.['isEstimated'] !== true
  ) return false;
  const content = payload?.['content'];
  if (typeof content !== 'string') return false;
  const lines = content.trimEnd().split('\n');
  if (lines.at(-1) !== CURSOR_HTTP2_CANCEL) return false;
  // An unterminated example block must not become an automatic continuation.
  const preceding = lines.slice(0, -1).join('\n');
  return (preceding.match(/```/g)?.length ?? 0) % 2 === 0
    && (preceding.match(/~~~/g)?.length ?? 0) % 2 === 0;
}

/** Abort also clears the timer, so removal and shutdown leave no pending work. */
export function waitForTransportRecovery(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
