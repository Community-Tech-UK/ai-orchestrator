import { EventEmitter } from 'events';
import type { LoopStage, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import type { LoopControlEnv } from './loop-control';
import {
  DEFAULT_ITERATION_TIMEOUT_MS,
  type LoopChildResult,
} from './loop-coordinator.types';

const logger = getLogger('LoopChildInvoker');

export interface InvokeLoopChildIterationInput {
  emitter: EventEmitter;
  state: LoopState;
  prompt: string;
  stage: LoopStage;
  forceContextReset: boolean;
  downshiftModel?: string;
  loopControlEnv?: LoopControlEnv;
  idempotencyKey: string;
}

interface LoopActivityPayload {
  loopRunId?: string;
  seq?: number;
  kind?: string;
}

export function invokeLoopChildIteration(input: InvokeLoopChildIterationInput): Promise<LoopChildResult> {
  const { emitter, state, stage } = input;
  if (emitter.listenerCount('loop:invoke-iteration') === 0) {
    throw new Error(
      'No handler registered for loop:invoke-iteration. ' +
      'Register one in src/main/index.ts to wire LLM invocation.',
    );
  }

  return new Promise<LoopChildResult>((resolve, reject) => {
    let settled = false;
    const correlationId = `${state.id}::${state.totalIterations}`;
    const iterationTimeoutMs = Math.max(
      1,
      state.config.iterationTimeoutMs ?? DEFAULT_ITERATION_TIMEOUT_MS,
    );
    const streamIdleTimeoutMs = Math.max(
      1,
      state.config.streamIdleTimeoutMs ?? 5 * 60 * 1000,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let lastActivityAt = 0;
    const seq = state.totalIterations;

    const onActivity = (payload: unknown): void => {
      const activity = payload as LoopActivityPayload;
      if (activity.loopRunId !== state.id || activity.seq !== seq) return;
      if (activity.kind === 'stream-idle' || activity.kind === 'error') return;
      lastActivityAt = Date.now();
    };

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      emitter.off('loop:activity', onActivity);
    };

    const scheduleTimeout = (delayMs: number): void => {
      timeout = setTimeout(handleTimeout, Math.max(1, delayMs));
    };

    const handleTimeout = (): void => {
      timeout = undefined;
      if (settled) return;
      const idleMs = lastActivityAt > 0 ? Date.now() - lastActivityAt : Number.POSITIVE_INFINITY;
      if (lastActivityAt > 0 && idleMs < streamIdleTimeoutMs) {
        const nextDelayMs = Math.max(
          1,
          Math.min(iterationTimeoutMs, streamIdleTimeoutMs - idleMs),
        );
        logger.info('Loop iteration timeout checkpoint extended while child is active', {
          loopRunId: state.id,
          seq,
          iterationTimeoutMs,
          streamIdleTimeoutMs,
          idleMs,
          nextDelayMs,
        });
        scheduleTimeout(nextDelayMs);
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Loop iteration timed out after ${iterationTimeoutMs}ms`));
    };

    emitter.on('loop:activity', onActivity);
    scheduleTimeout(iterationTimeoutMs);

    emitter.emit('loop:invoke-iteration', {
      correlationId,
      loopRunId: state.id,
      chatId: state.chatId,
      provider: state.config.provider,
      model: input.downshiftModel,
      workspaceCwd: state.config.workspaceCwd,
      executionCwd: state.config.executionCwd,
      stage,
      seq: state.totalIterations,
      idempotencyKey: input.idempotencyKey,
      config: state.config,
      prompt: input.prompt,
      loopControlEnv: input.loopControlEnv,
      iterationTimeoutMs: state.config.iterationTimeoutMs,
      streamIdleTimeoutMs: state.config.streamIdleTimeoutMs,
      // LF-4 RPI: recycle the same-session context before this iteration runs.
      forceContextReset: input.forceContextReset,
      callback: (result: LoopChildResult | { error: string }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if ('error' in result) reject(new Error(result.error));
        else resolve(result);
      },
    });
  });
}
