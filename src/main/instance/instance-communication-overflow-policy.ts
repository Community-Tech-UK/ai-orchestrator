import { getLogger } from '../logging/logger';
import { errorDiagnostic } from '../logging/source-diagnostics';
import { generateId } from '../../shared/utils/id-generator';
import { extractOverflowTokenCount } from '../context/ptl-retry';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { AdapterInputDispatch } from '../cli/adapters/base-cli-adapter.types';
import { assertAdapterInputCurrent } from '../cli/adapters/adapter-input-dispatch';
import type { FileAttachment, Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceCommunicationOverflowTracker, LastSentTurn } from './instance-communication-overflow-tracker';
import { captureInstanceRecoveryEpoch, invalidateInstanceRecoveryEpoch, isInstanceRecoveryEpochCurrent, recordInstanceTurnEnding } from './instance-turn-ending-state';

const logger = getLogger('InstanceCommunication');

const OVERFLOW_STOP_NOTICE = 'The context is still too long after recovery. Work is preserved. Shorten the next request before trying again.';

export interface OverflowPolicyHost {
  getCompactContext(): ((instanceId: string) => Promise<void>) | undefined;
  addToOutputBuffer(instance: Instance, message: OutputMessage): void;
  emitOutput(instanceId: string, message: OutputMessage): void;
  transitionInstanceStatus(instance: Instance, status: InstanceStatus): void;
  queueUpdate(instanceId: string, status: InstanceStatus): void;
  getAdapter(instanceId: string): CliAdapter | undefined;
  resetCircuitBreaker(instanceId: string): void;
}

export function buildOverflowRetryMessage(turn: LastSentTurn, finalMessage?: string): string {
  if (finalMessage !== undefined) return finalMessage;
  return turn.contextBlock
    ? `${turn.contextBlock}\n\n${turn.message}`
    : turn.message;
}

/**
 * Compact / retry / idle policy for context overflow.
 * Bookkeeping stays on InstanceCommunicationOverflowTracker; the manager remains the host.
 */
export class InstanceCommunicationOverflowPolicy {
  constructor(
    private readonly tracker: InstanceCommunicationOverflowTracker,
    private readonly host: OverflowPolicyHost,
  ) {}

  async recoverSendInputOverflow(opts: {
    instanceId: string;
    instance: Instance;
    errorText: string;
    message: string;
    attachments?: FileAttachment[];
    contextBlock?: string | null;
    internalSource?: LastSentTurn['internalSource'];
    adapter: CliAdapter;
    dispatch?: AdapterInputDispatch;
    finalMessage?: string;
    onRetryDelivered?: () => void;
    beforeRetry?: () => void;
    extraFields?: Record<string, unknown>;
  }): Promise<boolean> {
    if (!this.host.getCompactContext()) return false;
    return this.compactThenMaybeRetry({
      instanceId: opts.instanceId,
      instance: opts.instance,
      tokenSource: opts.errorText,
      path: 'sendInput',
      extraFields: opts.extraFields,
      retryTurn: {
        message: opts.message,
        attachments: opts.attachments,
        contextBlock: opts.contextBlock,
        internalSource: opts.internalSource,
      },
      adapter: opts.adapter,
      finalMessage: opts.finalMessage,
      beforeRetry: opts.beforeRetry,
      dispatch: opts.dispatch,
      onRetryDelivered: opts.onRetryDelivered,
    });
  }

  async recoverAdapterErrorOverflow(opts: {
    instanceId: string;
    instance: Instance;
    errorText: string;
    extraFields?: Record<string, unknown>;
    onRetryDelivered?: () => void;
  }): Promise<boolean> {
    if (!this.host.getCompactContext()) {
      this.logOverflowAttempt(opts.instanceId, opts.errorText, 'error', opts.extraFields);
      this.emitCompacting(opts.instance, opts.instanceId);
      logger.warn('No compactContext handler available', { instanceId: opts.instanceId });
      return false;
    }
    const lastMsg = this.tracker.getLastSent(opts.instanceId);
    const retryAdapter = this.host.getAdapter(opts.instanceId);
    return this.compactThenMaybeRetry({
      instanceId: opts.instanceId,
      instance: opts.instance,
      tokenSource: opts.errorText,
      path: 'error',
      extraFields: opts.extraFields,
      retryTurn: lastMsg,
      adapter: lastMsg ? retryAdapter : undefined,
      dispatch: this.tracker.getDispatch(opts.instanceId),
      finalMessage: this.tracker.getFinalMessage(opts.instanceId),
      onRetryDelivered: opts.onRetryDelivered,
      idleWhenRetryUnavailable: true,
    });
  }

  async compactSilentEmptyResponse(opts: {
    instanceId: string;
    instance: Instance;
    reason: string;
    detail?: string;
  }): Promise<boolean> {
    const compactContext = this.host.getCompactContext();
    if (!compactContext) return false;
    const current = this.recoveryFence(opts.instanceId, opts.instance);
    if (!current()) return true;
    recordInstanceTurnEnding(opts.instanceId, 'context_overflow');
    if (!this.tracker.claimCompaction(opts.instanceId) || this.nativeOwnsCompaction(this.host.getAdapter(opts.instanceId))) {
      this.stopOverflow(opts.instance, opts.instanceId);
      return true;
    }
    logger.warn('Silent context overflow suspected; compacting', {
      instanceId: opts.instanceId,
      reason: opts.reason,
      detail: opts.detail,
    });
    const compactingMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Empty response near the context limit. Compacting conversation history...',
      metadata: { contextOverflow: true, silentEmptyResponse: true },
    };
    this.host.addToOutputBuffer(opts.instance, compactingMessage);
    this.host.emitOutput(opts.instanceId, compactingMessage);
    try {
      await compactContext(opts.instanceId);
      if (!current()) return true;
      this.host.resetCircuitBreaker(opts.instanceId);
      this.tracker.clearWarning(opts.instanceId);
      return true;
    } catch (compactErr) {
      if (!current()) return true;
      this.stopOverflow(opts.instance, opts.instanceId);
      logger.error(
        'Compaction failed during silent overflow recovery',
        undefined,
        { instanceId: opts.instanceId, ...errorDiagnostic(compactErr) },
      );
      return true;
    }
  }

  private async compactThenMaybeRetry(opts: {
    instanceId: string;
    instance: Instance;
    tokenSource: string;
    path: 'sendInput' | 'error';
    extraFields?: Record<string, unknown>;
    retryTurn?: LastSentTurn;
    finalMessage?: string;
    adapter?: CliAdapter;
    beforeRetry?: () => void;
    dispatch?: AdapterInputDispatch;
    onRetryDelivered?: () => void;
    idleWhenRetryUnavailable?: boolean;
  }): Promise<boolean> {
    const compactContext = this.host.getCompactContext();
    if (!compactContext) return false;

    const sendInputPath = opts.path === 'sendInput';
    const current = this.recoveryFence(opts.instanceId, opts.instance);
    if (!current()) return true;
    recordInstanceTurnEnding(opts.instanceId, 'context_overflow');
    // Claude/OpenCode already exhaust their native reactive compaction before
    // reporting overflow. An outer compact/retry would create a second owner.
    if (this.nativeOwnsCompaction(opts.adapter) || !this.tracker.claimCompaction(opts.instanceId)) {
      this.stopOverflow(opts.instance, opts.instanceId);
      return true;
    }
    this.logOverflowAttempt(opts.instanceId, opts.tokenSource, opts.path, opts.extraFields);
    this.emitCompacting(opts.instance, opts.instanceId);

    try {
      await compactContext(opts.instanceId);
      if (!current()) return true;
      logger.info(
        sendInputPath ? 'Context compaction completed (sendInput path)' : 'Context compaction completed',
        { instanceId: opts.instanceId },
      );
      this.tracker.clearWarning(opts.instanceId);

      if (opts.retryTurn && opts.adapter) {
        opts.beforeRetry?.();
        if (!current()) return true;
        this.tracker.markRetried(opts.instanceId);
        const retryMessage = buildOverflowRetryMessage(opts.retryTurn, opts.finalMessage);
        const retryNote: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: 'Context compacted. Retrying the original request once.',
          metadata: { contextCompacted: true, retrying: true },
        };
        this.host.addToOutputBuffer(opts.instance, retryNote);
        this.host.emitOutput(opts.instanceId, retryNote);
        if (!current()) return true;
        this.host.transitionInstanceStatus(opts.instance, 'busy');
        this.host.queueUpdate(opts.instanceId, 'busy');
        opts.beforeRetry?.();
        if (!current()) return true;
        // Every later native write rechecks the original committed identity and
        // recovery epoch; retrying must not create a second continuation owner.
        const dispatch: AdapterInputDispatch = { ...opts.dispatch,
          assertCurrent: () => {
            if (!current()) {
              const error = new Error('Overflow retry no longer owns the original request');
              error.name = 'AbortError';
              throw error;
            }
            opts.beforeRetry?.();
            assertAdapterInputCurrent(opts.dispatch);
          },
        };
        // LT-657: a retried Harness turn keeps its developer-channel provenance.
        const internalSource = opts.retryTurn.internalSource;
        try {
          const retryAdapter = opts.adapter;
          const retryTurn = opts.retryTurn;
          const sendRetry = async (): Promise<void> => {
            dispatch.assertCurrent?.();
            const owner = retryAdapter as { hasPendingProviderAutoContinuation?: () => boolean };
            assertAdapterInputCurrent(opts.dispatch, owner.hasPendingProviderAutoContinuation?.() === true);
            await retryAdapter.sendInput(retryMessage, retryTurn.attachments, { internalSource, dispatch });
            if (current() && !dispatch.signal?.aborted) opts.onRetryDelivered?.();
          };
          if (opts.dispatch?.runInputRetry) await opts.dispatch.runInputRetry('context-overflow', sendRetry);
          else await sendRetry();
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.name === 'AbortError') return true;
          if (!current()) return true;
          logger.error(
            sendInputPath ? 'Retry after compaction failed (sendInput path)' : 'Retry after compaction failed',
            undefined,
            { instanceId: opts.instanceId, ...errorDiagnostic(retryErr) },
          );
          this.host.transitionInstanceStatus(opts.instance, 'idle');
          this.host.queueUpdate(opts.instanceId, 'idle');
          if (sendInputPath) throw retryErr;
        }
        return true;
      }

      if (opts.idleWhenRetryUnavailable) {
        this.goIdle(
          opts.instance,
          opts.instanceId,
          'Context compacted. Work is preserved. Send a shorter request to resume.',
        );
        return true;
      }
      return false;
    } catch (compactErr) {
      if (!current() || (compactErr instanceof Error && compactErr.name === 'AbortError')) return true;
      if (sendInputPath && this.tracker.hasRetried(opts.instanceId)) throw compactErr;
      logger.error(
        sendInputPath ? 'Context compaction failed (sendInput path)' : 'Context compaction failed',
        undefined,
        { instanceId: opts.instanceId, ...errorDiagnostic(compactErr) },
      );
      return false;
    }
  }

  private nativeOwnsCompaction(adapter: CliAdapter | undefined): boolean {
    const name = adapter?.getName?.();
    return name === 'claude-cli' || name === 'opencode-acp';
  }

  private recoveryFence(instanceId: string, instance: Instance): () => boolean {
    const epoch = captureInstanceRecoveryEpoch(instanceId);
    const requestCount = instance.requestCount;
    const adapter = this.host.getAdapter(instanceId);
    return () => isInstanceRecoveryEpochCurrent(instanceId, epoch)
      && instance.requestCount === requestCount
      && this.host.getAdapter(instanceId) === adapter
      && !['interrupting', 'interrupted', 'cancelling', 'cancelled', 'terminated', 'failed', 'hibernated'].includes(instance.status);
  }

  private stopOverflow(instance: Instance, instanceId: string): void {
    invalidateInstanceRecoveryEpoch(instanceId);
    recordInstanceTurnEnding(instanceId, 'context_overflow');
    this.goIdle(instance, instanceId, OVERFLOW_STOP_NOTICE);
  }

  private logOverflowAttempt(
    instanceId: string,
    tokenSource: string,
    path: 'sendInput' | 'error',
    extraFields?: Record<string, unknown>,
  ): void {
    const tokenInfo = extractOverflowTokenCount(tokenSource);
    logger.info(
      path === 'sendInput'
        ? 'Context overflow detected in sendInput path, attempting compaction'
        : 'Context overflow detected, attempting compaction',
      {
        instanceId,
        ...extraFields,
        observedTokens: tokenInfo.observed,
        maximumTokens: tokenInfo.maximum,
      },
    );
  }

  private emitCompacting(instance: Instance, instanceId: string): void {
    const compactingMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Context is too long. Compacting conversation history...',
      metadata: { contextOverflow: true },
    };
    this.host.addToOutputBuffer(instance, compactingMessage);
    this.host.emitOutput(instanceId, compactingMessage);
  }

  private goIdle(instance: Instance, instanceId: string, content: string): void {
    const current = this.recoveryFence(instanceId, instance);
    const idleMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content,
      metadata: { contextOverflow: true },
    };
    this.host.addToOutputBuffer(instance, idleMessage);
    this.host.emitOutput(instanceId, idleMessage);
    if (!current()) return;
    this.host.transitionInstanceStatus(instance, 'idle');
    this.host.queueUpdate(instanceId, 'idle');
  }
}
