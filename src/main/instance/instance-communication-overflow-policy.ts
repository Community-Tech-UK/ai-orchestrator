import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import { extractOverflowTokenCount } from '../context/ptl-retry';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { FileAttachment, Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceCommunicationOverflowTracker, LastSentTurn } from './instance-communication-overflow-tracker';

const logger = getLogger('InstanceCommunication');

export const OVERFLOW_DELEGATION_GUIDANCE = [
  '[SYSTEM: Context Overflow Recovery]',
  'Your context overflowed and has been compacted. To prevent this from happening again:',
  '1. Do NOT read large files directly — spawn child instances for file reading.',
  '2. Use get_child_summary instead of get_child_output for results.',
  '3. Summarize rather than copying full file contents.',
  'Your previous message is being retried. Follow the guidance above.',
  '[END SYSTEM]',
].join('\n');

export interface OverflowPolicyHost {
  getCompactContext(): ((instanceId: string) => Promise<void>) | undefined;
  addToOutputBuffer(instance: Instance, message: OutputMessage): void;
  emitOutput(instanceId: string, message: OutputMessage): void;
  transitionInstanceStatus(instance: Instance, status: InstanceStatus): void;
  queueUpdate(instanceId: string, status: InstanceStatus): void;
  getAdapter(instanceId: string): CliAdapter | undefined;
  resetCircuitBreaker(instanceId: string): void;
}

export function buildOverflowRetryMessage(turn: LastSentTurn): string {
  return turn.contextBlock
    ? `${turn.contextBlock}\n\n${OVERFLOW_DELEGATION_GUIDANCE}\n\n${turn.message}`
    : `${OVERFLOW_DELEGATION_GUIDANCE}\n\n${turn.message}`;
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
      beforeRetry: opts.beforeRetry,
    });
  }

  async recoverAdapterErrorOverflow(opts: {
    instanceId: string;
    instance: Instance;
    errorText: string;
    extraFields?: Record<string, unknown>;
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
      this.host.resetCircuitBreaker(opts.instanceId);
      this.tracker.clearWarning(opts.instanceId);
      return true;
    } catch (compactErr) {
      logger.error(
        'Compaction failed during silent overflow recovery',
        compactErr instanceof Error ? compactErr : undefined,
        { instanceId: opts.instanceId },
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
    adapter?: CliAdapter;
    beforeRetry?: () => void;
    idleWhenRetryUnavailable?: boolean;
  }): Promise<boolean> {
    const compactContext = this.host.getCompactContext();
    if (!compactContext) return false;

    const sendInputPath = opts.path === 'sendInput';
    this.logOverflowAttempt(opts.instanceId, opts.tokenSource, opts.path, opts.extraFields);
    this.emitCompacting(opts.instance, opts.instanceId);

    try {
      await compactContext(opts.instanceId);
      logger.info(
        sendInputPath ? 'Context compaction completed (sendInput path)' : 'Context compaction completed',
        { instanceId: opts.instanceId },
      );
      this.tracker.clearWarning(opts.instanceId);

      if (this.tracker.hasRetried(opts.instanceId)) {
        logger.warn(
          sendInputPath
            ? 'Already retried after overflow in sendInput path, going idle'
            : 'Already retried after overflow, skipping retry',
          { instanceId: opts.instanceId },
        );
        this.goIdle(
          opts.instance,
          opts.instanceId,
          'Context compacted. Please delegate large file reads to child instances and try again.',
        );
        return true;
      }

      if (opts.retryTurn && opts.adapter) {
        this.tracker.markRetried(opts.instanceId);
        const retryMessage = buildOverflowRetryMessage(opts.retryTurn);
        const retryNote: OutputMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: 'Context compacted and message retried with delegation guidance.',
          metadata: { contextCompacted: true, retrying: true },
        };
        this.host.addToOutputBuffer(opts.instance, retryNote);
        this.host.emitOutput(opts.instanceId, retryNote);
        this.host.transitionInstanceStatus(opts.instance, 'busy');
        this.host.queueUpdate(opts.instanceId, 'busy');
        opts.beforeRetry?.();
        // LT-657: a retried Harness turn keeps its developer-channel provenance.
        const internalSource = opts.retryTurn.internalSource;
        const retry = internalSource
          ? opts.adapter.sendInput(retryMessage, opts.retryTurn.attachments, { internalSource })
          : opts.adapter.sendInput(retryMessage, opts.retryTurn.attachments);
        retry.catch((retryErr) => {
          logger.error(
            sendInputPath ? 'Retry after compaction failed (sendInput path)' : 'Retry after compaction failed',
            retryErr instanceof Error ? retryErr : undefined,
            { instanceId: opts.instanceId },
          );
          this.host.transitionInstanceStatus(opts.instance, 'idle');
          this.host.queueUpdate(opts.instanceId, 'idle');
        });
        return true;
      }

      if (opts.idleWhenRetryUnavailable) {
        this.goIdle(
          opts.instance,
          opts.instanceId,
          'Context compacted. Please delegate large file reads to child instances and try again.',
        );
        return true;
      }
      return false;
    } catch (compactErr) {
      logger.error(
        sendInputPath ? 'Context compaction failed (sendInput path)' : 'Context compaction failed',
        compactErr instanceof Error ? compactErr : undefined,
        { instanceId: opts.instanceId },
      );
      return false;
    }
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
    const idleMessage: OutputMessage = {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content,
      metadata: { contextCompacted: true },
    };
    this.host.addToOutputBuffer(instance, idleMessage);
    this.host.emitOutput(instanceId, idleMessage);
    this.host.transitionInstanceStatus(instance, 'idle');
    this.host.queueUpdate(instanceId, 'idle');
  }
}
