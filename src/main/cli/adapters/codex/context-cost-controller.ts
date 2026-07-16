import type { InterruptResult, TurnInterruptCompletion } from '../base-cli-adapter';
import type { ProviderContextActionHandlerResult } from '../../../context-evidence/provider-context-action-executor';
import { getLogger } from '../../../logging/logger';
import { CompactionGate } from './compaction-gate';
import {
  CodexTurnCostGovernor,
  type CodexTurnCostObservation,
} from './turn-cost-governor';

const logger = getLogger('CodexContextCostController');

export const COST_RECOVERY_CONTINUATION =
  'Continue the interrupted task from where you left off. Inspect the current workspace state before acting, do not repeat completed edits or commands, and finish the original request.';

type RecoveryReason = 'interrupt-unconfirmed' | 'compaction-unobserved';
type RecoveryStage = 'interrupt-requested' | 'interrupt-observed' | 'compaction-observed' | 'continued' | 'paused';
export type CodexContextAction =
  | 'controlled-interrupt'
  | 'controlled-recovery'
  | 'native-compaction'
  | 'same-thread-continuation'
  | 'provider-counter-reset';
export type CodexContextActionProofStage = 'requested' | 'acknowledged' | 'observed';

interface PendingRecovery {
  action: 'controlled-interrupt' | 'controlled-recovery';
  interruptResult: InterruptResult;
}

export interface CodexContextCostControllerDeps {
  /** @deprecated Decisions are owned by ContextSafetyPolicy; retained for config compatibility. */
  enabled?: boolean;
  compactionTimeoutMs: number;
  interrupt(): InterruptResult;
  getCompactionTarget(): { threadId: string; start(): Promise<unknown> } | null;
  emitSystem(content: string, metadata: Record<string, unknown>): void;
  recordObservation?(observation: CodexTurnCostObservation): void;
  recordActionProof?(action: CodexContextAction, stage: CodexContextActionProofStage): void;
  recordRecovery?(stage: RecoveryStage, reasonCode?: RecoveryReason): void;
  recordCompactionRpc?(stage: 'requested' | 'accepted' | 'failed'): void;
}

export interface RecoverAfterTurnParams {
  turnStatus: string | null | undefined;
  recoveryCount: number;
  continueTurn(message: string, nextRecoveryCount: number): Promise<void>;
}

/** Codex action executor and proof observer. It contains no pressure thresholds. */
export class CodexContextCostController {
  private readonly gate = new CompactionGate();
  private readonly governor = new CodexTurnCostGovernor();
  private pendingRecovery: PendingRecovery | null = null;

  constructor(private readonly deps: CodexContextCostControllerDeps) {}

  observe(cumulativeTokens: number, contextWindow: number): void {
    const observation = this.governor.observe({ cumulativeTokens, contextWindow });
    this.deps.recordObservation?.(observation);
    if (observation.counterResetObserved) {
      this.deps.recordActionProof?.('provider-counter-reset', 'observed');
    }
  }

  async requestRecovery(
    action: 'controlled-interrupt' | 'controlled-recovery',
  ): Promise<ProviderContextActionHandlerResult> {
    if (this.pendingRecovery) return { proof: 'acknowledged' };
    this.deps.recordActionProof?.(action, 'requested');
    const interruptResult = this.deps.interrupt();
    if (interruptResult.status !== 'accepted' || !interruptResult.completion) {
      this.deps.emitSystem(
        'Codex context recovery paused because a safe interrupt could not be confirmed. The current turn remains preserved.',
        { contextCostRecoveryPaused: true, reasonCode: 'interrupt-unconfirmed' },
      );
      this.deps.recordRecovery?.('paused', 'interrupt-unconfirmed');
      return { proof: 'none' };
    }
    this.pendingRecovery = { action, interruptResult };
    this.deps.recordActionProof?.(action, 'acknowledged');
    this.deps.recordRecovery?.('interrupt-requested');
    return { proof: 'acknowledged' };
  }

  recordCompactionObserved(cumulativeTokens: number): void {
    const awaited = this.gate.hasPendingWaiters();
    this.gate.settle();
    this.governor.recordCompactionObserved(cumulativeTokens);
    if (!awaited) this.deps.recordActionProof?.('native-compaction', 'observed');
  }

  async compactContext(timeoutMs: number): Promise<boolean> {
    const observed = this.gate.wait(timeoutMs);
    if (!await this.startCompaction()) {
      this.gate.cancel();
      return false;
    }
    const outcome = await observed;
    if (outcome === 'observed') {
      this.deps.recordActionProof?.('native-compaction', 'observed');
      return true;
    }
    logger.warn('Context compaction was acknowledged but not observed', { timeoutMs, outcome });
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
        'Codex context recovery paused because the active turn did not confirm interruption. The conversation was preserved; retry when ready.',
      );
    }
    this.deps.recordActionProof?.(pending.action, 'observed');
    this.deps.recordRecovery?.('interrupt-observed');

    if (!await this.compactContext(this.deps.compactionTimeoutMs)) {
      throw this.pause(
        'compaction-unobserved',
        'Codex context recovery paused because compaction could not be confirmed. The conversation was preserved; retry or compact manually before continuing.',
      );
    }

    this.deps.recordRecovery?.('compaction-observed');
    this.deps.emitSystem(
      'Codex reached a shared context-policy boundary, so Harness interrupted it, observed compaction, and is continuing on the same thread.',
      { contextCostRecovery: true, action: pending.action },
    );
    this.deps.recordActionProof?.('same-thread-continuation', 'requested');
    await params.continueTurn(COST_RECOVERY_CONTINUATION, params.recoveryCount + 1);
    this.deps.recordActionProof?.('same-thread-continuation', 'observed');
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
      this.deps.recordActionProof?.('native-compaction', 'requested');
      this.deps.recordCompactionRpc?.('requested');
      await target.start();
      this.deps.recordActionProof?.('native-compaction', 'acknowledged');
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
