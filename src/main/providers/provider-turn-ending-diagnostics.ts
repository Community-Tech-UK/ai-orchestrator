import { createHash } from 'node:crypto';
import type { ProviderCompleteEvent } from '@contracts/types/provider-runtime-events';
import { getLogger } from '../logging/logger';
import { safeDiagnosticIdentifier, safeDiagnosticNativeEnding, safeDiagnosticNumber, safeDiagnosticToolKind } from '../cli/turn-ending-diagnostic-fields';

export interface TurnEndingDiagnosticContext { adapter?: string; model?: string }
const loggedEvents = new WeakMap<object, boolean>();

/** Allowlist diagnostics; never log response, thinking, tool inputs or errors. */
export function logProviderTurnCompletion(source: ProviderCompleteEvent, event: ProviderCompleteEvent, context: TurnEndingDiagnosticContext, thinking: readonly { content: string }[], activeToolKind?: string): void {
  const model = safeDiagnosticIdentifier(context.model);
  const previousHasModel = loggedEvents.get(source);
  if (previousHasModel !== undefined && (previousHasModel || !model)) { loggedEvents.set(event, previousHasModel); return; }
  // A later instance ingress may add a model unavailable to the raw adapter.
  loggedEvents.set(source, Boolean(model));
  loggedEvents.set(event, Boolean(model));
  getLogger('ProviderTurnEnding').info('Provider turn completed', {
    adapter: safeDiagnosticIdentifier(context.adapter), model,
    stopReason: safeDiagnosticNativeEnding(event.stopReason), finish: safeDiagnosticNativeEnding(event.finish),
    outputTokens: safeDiagnosticNumber(event.outputTokens), reasoningTokens: safeDiagnosticNumber(event.reasoningTokens),
    activeToolKind: safeDiagnosticToolKind(activeToolKind), classifierReason: event.turnEnding?.reason,
    ...(event.turnEnding?.reasoningCollapsed ? { collapsedTailHash: createHash('sha256').update(thinking.map((block) => block.content.slice(-4000)).join('\n')).digest('hex').slice(0, 16) } : {}),
  });
}
