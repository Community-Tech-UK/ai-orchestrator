import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { CodexContextCostController, CodexContextRecoveryPausedError } from './context-cost-controller';
import type { CompactionGateOutcome } from './compaction-gate';
import { isCompactTurnRejection } from './app-server-runtime-errors';

interface ProviderCompactionSendGateDeps {
  controller: CodexContextCostController;
  emitPaused(message: OutputMessage): void;
}

export async function awaitProviderCompactionSettled(
  deps: ProviderCompactionSendGateDeps,
  retainBusy = true,
): Promise<void> {
  if (!deps.controller.isCompactionRunning()) return;
  const outcome = await deps.controller.awaitCompactionSettled(retainBusy);
  if (outcome === 'observed') return;
  const message = pausedMessage(outcome);
  deps.emitPaused({
    id: generateId(),
    timestamp: Date.now(),
    type: 'system',
    content: message,
    metadata: { providerCompactionPaused: true, outcome },
  });
  throw new CodexContextRecoveryPausedError(message, 'compaction-unobserved');
}

/** Creates one outer-send gate whose unseen Compact rejection may be retried exactly once. */
export function createProviderCompactionSendGate(
  deps: ProviderCompactionSendGateDeps,
): <T>(send: () => Promise<T>) => Promise<T> {
  let compactRetryUsed = false;

  return async <T>(send: () => Promise<T>): Promise<T> => {
    await awaitProviderCompactionSettled(deps);
    try {
      return await send();
    } catch (error) {
      if (compactRetryUsed || !isCompactTurnRejection(error)) throw error;
      compactRetryUsed = true;
      deps.controller.markCompactionRunningFromRejection(null);
      await awaitProviderCompactionSettled(deps);
      return send();
    }
  };
}

function pausedMessage(outcome: Exclude<CompactionGateOutcome, 'observed'>): string {
  return `Codex is still compacting this thread (${outcome}). The message was not sent; retry after compaction finishes.`;
}
