import type { InstanceStatus, OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import type { CompactionGateOutcome } from './compaction-gate';

type CompactionTrigger = 'self-managed' | 'policy';
type CompletionOutcome = 'settled' | 'aborted' | Exclude<CompactionGateOutcome, 'observed'>;

interface ProviderCompactionPresentationDeps {
  hasActiveTurn(): boolean;
  hasPendingHandoff(): boolean;
  emitStatus(status: InstanceStatus): void;
  emitOutput(message: OutputMessage): void;
}

/** Owns transcript/status metadata for a provider compaction lifecycle. */
export class CodexProviderCompactionPresentation {
  private turnId: string | null = null;
  private trigger: CompactionTrigger = 'self-managed';

  constructor(private readonly deps: ProviderCompactionPresentationDeps) {}

  started(turnId: string | null, trigger: CompactionTrigger): void {
    this.turnId = turnId;
    this.trigger = trigger;
    if (!this.deps.hasActiveTurn()) this.deps.emitStatus('busy');
    this.deps.emitOutput(this.message(
      'started',
      'Codex is compacting the conversation before continuing.',
    ));
  }

  updateTurnId(turnId: string | null): void {
    if (turnId) this.turnId = turnId;
  }

  completed(outcome: 'observed' | CompletionOutcome): void {
    if (outcome !== 'observed') {
      const content = outcome === 'settled'
        ? 'Codex finished its provider compaction turn.'
        : `Codex ended its provider compaction wait without a confirmed completion (${outcome}).`;
      this.deps.emitOutput(this.message('completed', content, outcome));
      this.reset();
    }
    const successfulHandoff = (outcome === 'observed' || outcome === 'settled')
      && this.deps.hasPendingHandoff();
    if (!this.deps.hasActiveTurn() && !successfulHandoff) this.deps.emitStatus('idle');
  }

  enrichObserved(output: OutputMessage, completesLifecycle = true): void {
    output.metadata = {
      ...output.metadata,
      ...(completesLifecycle ? { providerCompaction: 'completed' } : {}),
      providerCompactionTurnId: this.turnId,
      providerCompactionTrigger: this.trigger,
    };
    if (completesLifecycle) this.reset();
  }

  private message(
    phase: 'started' | 'completed',
    content: string,
    outcome?: CompletionOutcome,
  ): OutputMessage {
    return {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content,
      metadata: {
        providerCompaction: phase,
        ...(outcome ? { providerCompactionOutcome: outcome } : {}),
        providerCompactionTurnId: this.turnId,
        providerCompactionTrigger: this.trigger,
      },
    };
  }

  private reset(): void {
    this.turnId = null;
    this.trigger = 'self-managed';
  }
}
