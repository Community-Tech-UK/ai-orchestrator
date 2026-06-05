import type {
  LoopState,
  LoopTerminalIntent,
} from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import {
  cloneIntentWithStatus,
  commitImportedIntent,
  importLoopTerminalIntents,
  latestIntentByReceivedAt,
  type LoopControlRuntime,
} from './loop-control';
import type { LoopIntentPersistHook } from './loop-coordinator.types';

const logger = getLogger('LoopTerminalIntentImporter');

export async function importTerminalIntentsForBoundary(opts: {
  state: LoopState;
  loopControl: LoopControlRuntime | undefined;
  options: { maxIterationSeq: number; exactIterationSeq?: number; terminalEligible: boolean };
  isTerminalStatus: (status: LoopState['status']) => boolean;
  isCancelled: (loopRunId: string) => boolean;
  emit: (eventName: string, payload: unknown) => void;
  transitionTerminalIntent: (
    state: LoopState,
    intent: LoopTerminalIntent,
    status: LoopTerminalIntent['status'],
    reason: string,
  ) => LoopTerminalIntent;
  rememberTerminalIntent: (state: LoopState, intent: LoopTerminalIntent) => void;
  persistHook: LoopIntentPersistHook | null;
}): Promise<void> {
  const { state, loopControl, options } = opts;
  if (opts.isTerminalStatus(state.status) || opts.isCancelled(state.id)) return;
  if (!loopControl) return;

  let imported: Awaited<ReturnType<typeof importLoopTerminalIntents>>;
  try {
    imported = await importLoopTerminalIntents(loopControl, options);
  } catch (err) {
    if (!opts.isTerminalStatus(state.status) && !opts.isCancelled(state.id)) {
      logger.warn('Failed to import loop-control intents', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  for (const rejection of imported.rejected) {
    opts.emit('loop:activity', {
      loopRunId: state.id,
      seq: options.exactIterationSeq ?? state.totalIterations,
      stage: state.currentStage,
      timestamp: Date.now(),
      kind: 'error',
      message: `Rejected loop-control intent: ${rejection.reason}`,
      detail: { filePath: rejection.filePath },
    });
  }
  if (imported.accepted.length === 0) return;

  const latest = latestIntentByReceivedAt(imported.accepted);
  if (!latest) return;

  if (state.terminalIntentPending && state.terminalIntentPending.id !== latest.id) {
    opts.transitionTerminalIntent(state, state.terminalIntentPending, 'superseded', `superseded by ${latest.id}`);
  }
  const persistOrder: { intent: LoopTerminalIntent; filePath: string | undefined }[] = [];
  for (const intent of imported.accepted) {
    if (intent.id === latest.id) continue;
    const superseded = cloneIntentWithStatus(intent, 'superseded', `superseded by ${latest.id}`);
    opts.rememberTerminalIntent(state, superseded);
    persistOrder.push({ intent: superseded, filePath: intent.filePath });
  }
  opts.rememberTerminalIntent(state, latest);
  persistOrder.push({ intent: latest, filePath: latest.filePath });
  state.terminalIntentPending = latest;

  if (opts.persistHook) {
    for (const entry of persistOrder) {
      try {
        await opts.persistHook(entry.intent);
      } catch (err) {
        logger.warn('Intent persist hook failed - leaving source file in intents/ for next boundary', {
          loopRunId: state.id,
          intentId: entry.intent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        opts.emit('loop:terminal-intent-rejected', {
          loopRunId: state.id,
          intent: cloneIntentWithStatus(entry.intent, 'rejected', 'persist-hook-failed'),
          reason: err instanceof Error ? err.message : String(err),
        });
        if (state.terminalIntentPending?.id === entry.intent.id) {
          state.terminalIntentPending = undefined;
        }
        return;
      }
    }
  }

  for (const entry of persistOrder) {
    if (!entry.filePath) continue;
    await commitImportedIntent(loopControl, entry.filePath).catch((err: unknown) => {
      logger.warn('Failed to archive imported intent file after persistence; retry on next boundary', {
        loopRunId: state.id,
        intentId: entry.intent.id,
        filePath: entry.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  opts.emit('loop:terminal-intent-recorded', { loopRunId: state.id, intent: latest });
  opts.emit('loop:activity', {
    loopRunId: state.id,
    seq: latest.iterationSeq,
    stage: state.currentStage,
    timestamp: Date.now(),
    kind: 'status',
    message: `Loop-control ${latest.kind} intent recorded: ${latest.summary}`,
    detail: { intentId: latest.id, kind: latest.kind },
  });
}
