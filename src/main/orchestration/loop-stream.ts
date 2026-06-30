import type { EventEmitter } from 'events';
import type {
  CompletionSignalEvidence,
  LoopState,
  LoopStage,
  LoopStreamEvent,
  LoopStreamTerminalStatus,
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
  let terminalEmitted = false;
  const finish = () => {
    done = true;
    if (resolve) { resolve(); resolve = null; }
  };
  const pushTerminal = (e: LoopStreamEvent) => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    push(e);
    finish();
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
      pushTerminal({ type: 'completed', loopRunId, signal: d.signal, verifyOutput: d.verifyOutput });
    }
  };
  const onCompletedNeedsReview = (d: { loopRunId: string; reason: string; acceptedByOperator: boolean }) => {
    if (d.loopRunId === loopRunId) {
      pushTerminal({
        type: 'completed-needs-review',
        loopRunId,
        reason: d.reason,
        acceptedByOperator: d.acceptedByOperator,
      });
    }
  };
  const onProviderLimit = (d: {
    loopRunId: string;
    reason?: string;
    willResume: boolean;
    resumeAt?: number | null;
  }) => {
    if (d.loopRunId !== loopRunId) return;
    const event: LoopStreamEvent = {
      type: 'provider-limit',
      loopRunId,
      reason: d.reason,
      willResume: d.willResume,
      resumeAt: d.resumeAt,
    };
    if (d.willResume) push(event);
    else pushTerminal(event);
  };
  const onFailed = (d: { loopRunId: string; reason: string }) => {
    if (d.loopRunId === loopRunId) {
      pushTerminal({ type: 'failed', loopRunId, reason: d.reason });
    }
  };
  const onCap = (d: { loopRunId: string; cap: 'iterations' | 'wall-time' | 'tokens' | 'cost'; reason?: string }) => {
    if (d.loopRunId === loopRunId) {
      pushTerminal({ type: 'cap-reached', loopRunId, cap: d.cap, reason: d.reason });
    }
  };
  const onCancelled = (d: { loopRunId: string }) => {
    if (d.loopRunId === loopRunId) {
      pushTerminal({ type: 'cancelled', loopRunId });
    }
  };
  const onError = (d: { loopRunId: string; error: string }) => {
    if (d.loopRunId === loopRunId) {
      pushTerminal({ type: 'error', loopRunId, error: d.error });
    }
  };
  const onStateChanged = (d: { loopRunId: string; state: Pick<LoopState, 'status' | 'endReason' | 'endedAt'> }) => {
    if (d.loopRunId !== loopRunId || terminalEmitted) return;
    const terminalStatus = streamTerminalStatus(d.state);
    if (!terminalStatus) return;
    pushTerminal({
      type: 'terminal-status',
      loopRunId,
      status: terminalStatus,
      reason: d.state.endReason,
    });
  };

  emitter.on('loop:iteration-started', onIterationStarted);
  emitter.on('loop:iteration-complete', onIterationComplete);
  emitter.on('loop:paused-no-progress', onPaused);
  emitter.on('loop:claimed-done-but-failed', onClaimedFailed);
  emitter.on('loop:terminal-intent-recorded', onTerminalIntentRecorded);
  emitter.on('loop:terminal-intent-rejected', onTerminalIntentRejected);
  emitter.on('loop:intervention-applied', onIntervention);
  emitter.on('loop:completed', onCompleted);
  emitter.on('loop:completed-needs-review', onCompletedNeedsReview);
  emitter.on('loop:provider-limit', onProviderLimit);
  emitter.on('loop:failed', onFailed);
  emitter.on('loop:cap-reached', onCap);
  emitter.on('loop:cancelled', onCancelled);
  emitter.on('loop:error', onError);
  emitter.on('loop:state-changed', onStateChanged);

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
    emitter.off('loop:completed-needs-review', onCompletedNeedsReview);
    emitter.off('loop:provider-limit', onProviderLimit);
    emitter.off('loop:failed', onFailed);
    emitter.off('loop:cap-reached', onCap);
    emitter.off('loop:cancelled', onCancelled);
    emitter.off('loop:error', onError);
    emitter.off('loop:state-changed', onStateChanged);
  }
}

function streamTerminalStatus(state: Pick<LoopState, 'status' | 'endedAt'>): LoopStreamTerminalStatus | null {
  switch (state.status) {
    case 'no-progress':
    case 'cost-exceeded':
    case 'needs-human-arbitration':
    case 'reviewer-unreliable':
    case 'reviewer-unavailable':
    case 'builder-unreliable':
      return state.status;
    case 'provider-limit':
      return state.endedAt == null ? null : state.status;
    default:
      return null;
  }
}
