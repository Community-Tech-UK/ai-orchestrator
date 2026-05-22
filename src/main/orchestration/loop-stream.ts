import type { EventEmitter } from 'events';
import type {
  CompletionSignalEvidence,
  LoopStage,
  LoopStreamEvent,
  LoopTerminalIntent,
  LoopVerdict,
  ProgressSignalEvidence,
} from '../../shared/types/loop.types';

interface LoopStreamEventsOptions {
  emitter: EventEmitter;
  loopRunId: string;
  chatId: string;
}

export async function* streamLoopEvents({
  emitter,
  loopRunId,
  chatId,
}: LoopStreamEventsOptions): AsyncGenerator<LoopStreamEvent> {
  const queue: LoopStreamEvent[] = [];
  let resolve: (() => void) | null = null;
  let done = false;
  const push = (e: LoopStreamEvent) => {
    queue.push(e);
    if (resolve) {
      resolve();
      resolve = null;
    }
  };

  const onIterationStarted = (d: { loopRunId: string; seq: number; stage: LoopStage }) => {
    if (d.loopRunId === loopRunId) push({ type: 'iteration-started', loopRunId, seq: d.seq, stage: d.stage });
  };
  const onIterationComplete = (d: { loopRunId: string; seq: number; verdict: LoopVerdict }) => {
    if (d.loopRunId === loopRunId) push({ type: 'iteration-complete', loopRunId, seq: d.seq, verdict: d.verdict });
  };
  const onPaused = (d: { loopRunId: string; signal: ProgressSignalEvidence }) => {
    if (d.loopRunId === loopRunId) push({ type: 'paused-no-progress', loopRunId, signal: d.signal });
  };
  const onClaimedFailed = (d: { loopRunId: string; signal: CompletionSignalEvidence['id']; failure: string }) => {
    if (d.loopRunId === loopRunId) push({ type: 'claimed-done-but-failed', loopRunId, signal: d.signal, failure: d.failure });
  };
  const onTerminalIntentRecorded = (d: { loopRunId: string; intent: LoopTerminalIntent }) => {
    if (d.loopRunId === loopRunId) push({ type: 'terminal-intent-recorded', loopRunId, intent: d.intent });
  };
  const onTerminalIntentRejected = (d: { loopRunId: string; intent: LoopTerminalIntent; reason: string }) => {
    if (d.loopRunId === loopRunId) push({ type: 'terminal-intent-rejected', loopRunId, intent: d.intent, reason: d.reason });
  };
  const onIntervention = (d: { loopRunId: string; message: string }) => {
    if (d.loopRunId === loopRunId) push({ type: 'intervention-applied', loopRunId, message: d.message });
  };
  const onCompleted = (d: { loopRunId: string; signal: CompletionSignalEvidence['id']; verifyOutput: string }) => {
    if (d.loopRunId === loopRunId) {
      push({ type: 'completed', loopRunId, signal: d.signal, verifyOutput: d.verifyOutput });
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }
  };
  const onFailed = (d: { loopRunId: string; reason: string }) => {
    if (d.loopRunId === loopRunId) {
      push({ type: 'failed', loopRunId, reason: d.reason });
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }
  };
  const onCap = (d: { loopRunId: string; cap: 'iterations' | 'wall-time' | 'tokens' | 'cost' }) => {
    if (d.loopRunId === loopRunId) {
      push({ type: 'cap-reached', loopRunId, cap: d.cap });
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }
  };
  const onCancelled = (d: { loopRunId: string }) => {
    if (d.loopRunId === loopRunId) {
      push({ type: 'cancelled', loopRunId });
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }
  };
  const onError = (d: { loopRunId: string; error: string }) => {
    if (d.loopRunId === loopRunId) {
      push({ type: 'error', loopRunId, error: d.error });
      done = true;
      if (resolve) { resolve(); resolve = null; }
    }
  };

  emitter.on('loop:iteration-started', onIterationStarted);
  emitter.on('loop:iteration-complete', onIterationComplete);
  emitter.on('loop:paused-no-progress', onPaused);
  emitter.on('loop:claimed-done-but-failed', onClaimedFailed);
  emitter.on('loop:terminal-intent-recorded', onTerminalIntentRecorded);
  emitter.on('loop:terminal-intent-rejected', onTerminalIntentRejected);
  emitter.on('loop:intervention-applied', onIntervention);
  emitter.on('loop:completed', onCompleted);
  emitter.on('loop:failed', onFailed);
  emitter.on('loop:cap-reached', onCap);
  emitter.on('loop:cancelled', onCancelled);
  emitter.on('loop:error', onError);

  yield { type: 'started', loopRunId, chatId };

  try {
    while (!done) {
      if (queue.length > 0) yield queue.shift()!;
      else await new Promise<void>((r) => { resolve = r; });
    }
    while (queue.length > 0) yield queue.shift()!;
  } finally {
    emitter.off('loop:iteration-started', onIterationStarted);
    emitter.off('loop:iteration-complete', onIterationComplete);
    emitter.off('loop:paused-no-progress', onPaused);
    emitter.off('loop:claimed-done-but-failed', onClaimedFailed);
    emitter.off('loop:terminal-intent-recorded', onTerminalIntentRecorded);
    emitter.off('loop:terminal-intent-rejected', onTerminalIntentRejected);
    emitter.off('loop:intervention-applied', onIntervention);
    emitter.off('loop:completed', onCompleted);
    emitter.off('loop:failed', onFailed);
    emitter.off('loop:cap-reached', onCap);
    emitter.off('loop:cancelled', onCancelled);
    emitter.off('loop:error', onError);
  }
}
