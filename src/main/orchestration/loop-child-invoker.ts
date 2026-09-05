import { EventEmitter } from 'events';
import type { LoopStage, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import type { LoopControlEnv } from './loop-control';
import { inferLoopPhase, type LoopInferredPhase } from './loop-phase-inference';
import {
  DEFAULT_ITERATION_TIMEOUT_MS,
  type LoopChildInvocationCallbackResult,
  type LoopChildInvocationError,
  type LoopChildResult,
} from './loop-coordinator.types';

const logger = getLogger('LoopChildInvoker');

export interface InvokeLoopChildIterationInput {
  emitter: EventEmitter;
  state: LoopState;
  prompt: string;
  /** Goal-bearing prompt used only for model routing (T2). */
  routingPrompt?: string;
  stage: LoopStage;
  forceContextReset: boolean;
  downshiftModel?: string;
  loopControlEnv?: LoopControlEnv;
  idempotencyKey: string;
  /**
   * D2 (#6): enforce the tools-disabled wrap-up for this iteration. Set by the
   * coordinator only for cap wrap-up turns; the listener applies the adapter
   * override where the provider supports one (see loop-tools-disable.ts) and
   * falls back to the prompt-only directive elsewhere.
   */
  disableTools?: boolean;
  /**
   * L4: advisory intra-iteration phase inferred from the command stream.
   * Called only when the classification changes. Never gates anything.
   */
  onPhase?: (phase: LoopInferredPhase) => void;
}

interface LoopActivityPayload {
  loopRunId?: string;
  seq?: number;
  kind?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

function contextWindowTokensForInvocation(
  state: LoopState,
  requestedModel: string | undefined,
): number | undefined {
  const calibration = state.contextWindowCalibration;
  if (!calibration || calibration.provider !== state.config.provider) return undefined;
  const normalizedRequestedModel = requestedModel && requestedModel !== 'default'
    ? requestedModel
    : undefined;
  if (normalizedRequestedModel && calibration.model !== normalizedRequestedModel) return undefined;
  return calibration.windowTokens;
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
    const startedAt = Date.now();
    const maxWallMs = iterationTimeoutMs * 2;
    const seq = state.totalIterations;

    let lastPhase: LoopInferredPhase | null = null;
    const onActivity = (payload: unknown): void => {
      const activity = payload as LoopActivityPayload;
      if (activity.loopRunId !== state.id || activity.seq !== seq) return;
      // L4: advisory phase inference, before the deadline filter — a heartbeat
      // never reaches here anyway, and a tool_use should update the phase even
      // if a later rule changes what counts as deadline progress.
      if (input.onPhase && typeof activity.message === 'string') {
        const phase = inferLoopPhase({
          kind: activity.kind ?? '',
          message: activity.message,
          detail: activity.detail,
        });
        if (phase && phase !== lastPhase) {
          lastPhase = phase;
          input.onPhase(phase);
        }
      }
      if (
        activity.kind === 'stream-idle'
        || activity.kind === 'error'
        || activity.kind === 'heartbeat'
      ) {
        return;
      }
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
      const now = Date.now();
      const elapsedMs = now - startedAt;
      const remainingWallMs = maxWallMs - elapsedMs;
      if (remainingWallMs <= 0) {
        settled = true;
        cleanup();
        emitter.emit('loop:iteration-timeout', {
          loopRunId: state.id,
          seq,
          iterationTimeoutMs,
        });
        reject(new Error(`Loop iteration timed out after ${iterationTimeoutMs}ms`));
        return;
      }
      const idleMs = lastActivityAt > 0 ? now - lastActivityAt : Number.POSITIVE_INFINITY;
      if (lastActivityAt > 0 && idleMs < streamIdleTimeoutMs) {
        const nextDelayMs = Math.max(
          1,
          Math.min(iterationTimeoutMs, streamIdleTimeoutMs - idleMs, remainingWallMs),
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
      emitter.emit('loop:iteration-timeout', {
        loopRunId: state.id,
        seq,
        iterationTimeoutMs,
      });
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
      routingPrompt: input.routingPrompt,
      loopControlEnv: input.loopControlEnv,
      iterationTimeoutMs: state.config.iterationTimeoutMs,
      streamIdleTimeoutMs: state.config.streamIdleTimeoutMs,
      contextWindowTokens: contextWindowTokensForInvocation(state, input.downshiftModel),
      // LF-4 RPI: recycle the same-session context before this iteration runs.
      forceContextReset: input.forceContextReset,
      // D2 (#6): tools-disabled wrap-up enforcement (cap wrap-up turns only).
      disableTools: input.disableTools === true,
      callback: (result: LoopChildInvocationCallbackResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if ('error' in result) reject(toInvocationError(result));
        else resolve(result);
      },
    });
  });
}

function toInvocationError(result: LoopChildInvocationError): Error {
  const error = new Error(result.error) as Error & Omit<LoopChildInvocationError, 'error'>;
  if (result.status !== undefined) error.status = result.status;
  if (result.statusCode !== undefined) error.statusCode = result.statusCode;
  if (result.code !== undefined) error.code = result.code;
  if (result.headers !== undefined) error.headers = result.headers;
  if (result.body !== undefined) error.body = result.body;
  if (result.provider !== undefined) error.provider = result.provider;
  if (result.model !== undefined) error.model = result.model;
  if (result.instanceId !== undefined) error.instanceId = result.instanceId;
  if (result.partialUsage !== undefined) error.partialUsage = result.partialUsage;
  // WS5: carry the failed attempt's workspace-effect evidence to the retry seam.
  if (result.attemptEvidence !== undefined) error.attemptEvidence = result.attemptEvidence;
  return error;
}
