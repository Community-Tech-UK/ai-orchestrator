import type { InterruptResult, TurnInterruptCompletion } from '../base-cli-adapter';
import { getLogger } from '../../../logging/logger';
import { CompactionGate } from './compaction-gate';
import {
  CodexTurnCostGovernor,
  type CodexTurnCostAction,
  type CodexTurnCostDecision,
} from './turn-cost-governor';

const logger = getLogger('CodexContextCostController');
const MAX_RECOVERIES_PER_SEND = 3;

export const COST_RECOVERY_CONTINUATION =
  'Continue the interrupted task from where you left off. Inspect the current workspace state before acting, do not repeat completed edits or commands, and finish the original request.';

type RecoveryReason = 'interrupt-unconfirmed' | 'compaction-unobserved' | 'recovery-limit';
type RecoveryStage = 'interrupt-requested' | 'interrupt-observed' | 'compaction-observed' | 'continued' | 'paused';

interface PendingRecovery {
  decision: CodexTurnCostDecision;
  interruptResult: InterruptResult;
}

type ActionableDecision = Omit<CodexTurnCostDecision, 'action'> & {
  action: Exclude<CodexTurnCostAction, 'continue'>;
};

export interface CodexContextCostControllerDeps {
  enabled: boolean;
  compactionTimeoutMs: number;
  interrupt(): InterruptResult;
  getCompactionTarget(): { threadId: string; start(): Promise<unknown> } | null;
  emitSystem(content: string, metadata: Record<string, unknown>): void;
  recordDecision?(decision: ActionableDecision): void;
  recordRecovery?(stage: RecoveryStage, reasonCode?: RecoveryReason): void;
  recordCompactionRpc?(stage: 'requested' | 'accepted' | 'failed'): void;
}

export interface RecoverAfterTurnParams {
  turnStatus: string | null | undefined;
  recoveryCount: number;
  continueTurn(message: string, nextRecoveryCount: number): Promise<void>;
}

export class CodexContextCostController {
  private readonly gate = new CompactionGate();
  private readonly governor = new CodexTurnCostGovernor();
  private pendingRecovery: PendingRecovery | null = null;

  constructor(private readonly deps: CodexContextCostControllerDeps) {}

  observe(cumulativeTokens: number, contextWindow: number): void {
    if (!this.deps.enabled || this.pendingRecovery) return;
    const decision = this.governor.observe({ cumulativeTokens, contextWindow });
    if (decision.action === 'continue') return;
    this.deps.recordDecision?.({ ...decision, action: decision.action });

    if (decision.action === 'warn') {
      this.deps.emitSystem(
        `Codex has processed ${decision.multiple.toFixed(1)} context windows in this turn. Harness will safely compact and continue if it reaches the cost ceiling.`,
        { contextCostWarning: true, spendMultiple: decision.multiple },
      );
      return;
    }

    const interruptResult = this.deps.interrupt();
    if (interruptResult.status !== 'accepted' || !interruptResult.completion) {
      this.deps.emitSystem(
        'Codex crossed the turn cost ceiling, but Harness could not arm a safe interrupt. The current turn is still running.',
        { contextCostRecoveryPaused: true, reasonCode: 'interrupt-unconfirmed' },
      );
      this.deps.recordRecovery?.('paused', 'interrupt-unconfirmed');
      this.governor.recordRecoveryAttemptFailed();
      return;
    }
    this.pendingRecovery = { decision, interruptResult };
    this.deps.recordRecovery?.('interrupt-requested');
  }

  recordCompactionObserved(cumulativeTokens: number): void {
    this.gate.settle();
    this.governor.recordCompactionObserved(cumulativeTokens);
  }

  async compactContext(timeoutMs: number): Promise<boolean> {
    const observed = this.gate.wait(timeoutMs);
    if (!await this.startCompaction()) {
      this.gate.cancel();
      return false;
    }
    const outcome = await observed;
    if (outcome === 'observed') return true;
    logger.warn('Context compaction was accepted but not observed', { timeoutMs });
    return false;
  }

  async recoverAfterTurn(params: RecoverAfterTurnParams): Promise<boolean> {
    const pending = this.pendingRecovery;
    if (!pending) return false;
    this.pendingRecovery = null;

    const completion = pending.interruptResult.completion
      ? await pending.interruptResult.completion
      : { status: params.turnStatus ?? 'unknown' } as TurnInterruptCompletion;
    if (completion.status === 'completed' || params.turnStatus === 'completed') return false;
    if (completion.status !== 'interrupted' || params.turnStatus !== 'interrupted') {
      throw this.pause(
        'interrupt-unconfirmed',
        'Codex context-cost recovery paused because the active turn did not confirm interruption. The conversation was preserved; retry when ready.',
      );
    }
    this.deps.recordRecovery?.('interrupt-observed');

    if (params.recoveryCount >= MAX_RECOVERIES_PER_SEND) {
      throw this.pause(
        'recovery-limit',
        `Codex context-cost recovery limit (${MAX_RECOVERIES_PER_SEND}) reached. The conversation was preserved; review progress before continuing.`,
      );
    }
    if (!await this.compactContext(this.deps.compactionTimeoutMs)) {
      throw this.pause(
        'compaction-unobserved',
        'Codex context-cost recovery paused because compaction could not be confirmed. The conversation was preserved; retry or compact manually before continuing.',
      );
    }

    this.deps.recordRecovery?.('compaction-observed');
    this.deps.emitSystem(
      'Codex reached the turn cost ceiling, so Harness interrupted it at a request boundary, compacted the thread, and is continuing safely.',
      {
        contextCostRecovery: true,
        action: pending.decision.action,
        spendMultiple: pending.decision.multiple,
      },
    );
    await params.continueTurn(COST_RECOVERY_CONTINUATION, params.recoveryCount + 1);
    this.deps.recordRecovery?.('continued');
    return true;
  }

  clearPending(): void {
    this.pendingRecovery = null;
  }

  private async startCompaction(): Promise<boolean> {
    const target = this.deps.getCompactionTarget();
    if (!target) return false;
    try {
      this.deps.recordCompactionRpc?.('requested');
      await target.start();
      this.deps.recordCompactionRpc?.('accepted');
      return true;
    } catch (error) {
      this.deps.recordCompactionRpc?.('failed');
      logger.warn('Context compaction failed', {
        threadId: target.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private pause(reasonCode: RecoveryReason, message: string): Error {
    this.deps.recordRecovery?.('paused', reasonCode);
    this.deps.emitSystem(message, { contextCostRecoveryPaused: true, reasonCode });
    return new Error(message);
  }
}
