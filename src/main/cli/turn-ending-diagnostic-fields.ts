/** Provider RPC payloads are untrusted even when their TypeScript type is narrow. */
const nativeEndings = new Set(['end_turn', 'stop', 'complete', 'completed', 'max_tokens', 'max_output_tokens', 'length', 'repetition_truncation', 'refusal', 'content_filter', 'content_filtered', 'tool_calls', 'tool_use', 'pause_turn', 'tool_deferred', 'cancelled', 'canceled', 'interrupted', 'error', 'model_context_window_exceeded']);
const toolKinds = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

export const safeDiagnosticIdentifier = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w ./:-]{1,160}$/.test(value) ? value : undefined;

export function safeDiagnosticNativeEnding(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const normalized = value.toLowerCase().replace(/[- ]/g, '_');
  return nativeEndings.has(normalized) ? normalized : 'other';
}

export const safeDiagnosticNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export const safeDiagnosticToolKind = (value: unknown): string | undefined =>
  typeof value === 'string' ? toolKinds.has(value) ? value : 'other' : undefined;
