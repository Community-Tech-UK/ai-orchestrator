import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { getLogger } from '../../../logging/logger';
import { isCodexInputTooLargeError, isRecoverableThreadResumeError } from './exec-error-classifier';
import type { CodexContextCostController } from './context-cost-controller';
import { recoverFromInputCap } from './input-cap-recovery';
import { createProviderCompactionSendGate } from './provider-compaction-send-gate';

const logger = getLogger('CodexCliAdapter');

interface CodexAppServerMessageSendDeps {
  controller: CodexContextCostController;
  threadId(): string | null;
  sendInner(): Promise<void>;
  compact(): Promise<boolean>;
  reopenThread(): Promise<void>;
  clearPending(): void;
  emitOutput(message: OutputMessage): void;
}

/** Runs one app-server send with provider-compaction and input-cap recovery. */
export async function sendCodexAppServerMessage(deps: CodexAppServerMessageSendDeps): Promise<void> {
  const gatedSend = createProviderCompactionSendGate({
    controller: deps.controller,
    emitPaused: deps.emitOutput,
  });
  const send = () => gatedSend(deps.sendInner);
  try {
    await send();
  } catch (error) {
    if (isCodexInputTooLargeError(error)) {
      logger.warn('Codex app-server turn exceeded per-turn input char cap; recovering', {
        threadId: deps.threadId(),
        cause: error instanceof Error ? error.message : String(error),
      });
      await recoverFromInputCap({
        send,
        compact: deps.compact,
        reopenThread: deps.reopenThread,
        onThreadReset: () => deps.emitOutput({
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content:
            'The conversation exceeded Codex’s per-turn size limit and could not be compacted, so a fresh Codex thread was started. Earlier context from this thread was cleared.',
          metadata: { threadReset: true, reason: 'per-turn-input-cap' },
        }),
      });
      return;
    }
    if (!isRecoverableThreadResumeError(error)) throw error;
    logger.warn('Codex app-server thread became unavailable; refusing context-empty retry', {
      threadId: deps.threadId(),
      cause: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    deps.clearPending();
  }
}
