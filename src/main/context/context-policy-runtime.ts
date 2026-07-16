import type {
  ContextPressureSample,
  ProviderContextCapabilities,
} from '@contracts/types/context-evidence';
import type { ContextUsage } from '../../shared/types/instance.types';
import type { ContextEvidenceMode } from '../../shared/types/settings.types';
import {
  ContextSafetyPolicy,
  createInitialContextSafetyPolicyState,
  type ContextSafetyPolicyState,
} from '../context-evidence/context-safety-policy';
import type {
  ProviderContextActionExecutor,
  ProviderContextExecutableAction,
} from '../context-evidence/provider-context-action-executor';

export interface ContextPolicyEvent {
  instanceId: string;
  eventKind: 'decision' | 'action-proof' | 'proof-boundary';
  recoveryEpoch: number;
  thresholdCode?: string;
  actionCode?: string;
  proofStage?: 'requested' | 'acknowledged' | 'observed';
  occupancyUsed?: number;
  occupancyTotal?: number;
  cumulativeTokens?: number;
  outputBytes: number;
  providerRequestCount: number;
  newEvidenceCount: number;
  newFindingCount: number;
  failureCode?: string;
  createdAt: number;
}

interface ContextPolicyObservation {
  instanceId: string;
  usage: ContextUsage;
  capabilities: ProviderContextCapabilities;
  mode: ContextEvidenceMode;
  autoCompactEnabled: boolean;
  executor: ProviderContextActionExecutor | null;
  circuitBreakerTripped: boolean;
  onActionFailure(): void;
  onActionSuccess(): void;
}

/** Stateful serialization shell around the pure shared ContextSafetyPolicy. */
export class ContextPolicyRuntime {
  private readonly policy = new ContextSafetyPolicy();
  private readonly states = new Map<string, ContextSafetyPolicyState>();
  private readonly queueTails = new Map<string, Promise<void>>();
  private readonly requestCounts = new Map<string, number>();
  private readonly lastCumulativeTokens = new Map<string, number>();
  private readonly proofStages = new Set<string>();

  constructor(private readonly publish: (event: ContextPolicyEvent) => void) {}

  observe(input: ContextPolicyObservation): void {
    const requestCount = (this.requestCounts.get(input.instanceId) ?? 0) + 1;
    this.requestCounts.set(input.instanceId, requestCount);
    this.observeCounterReset(input.instanceId, input.usage);
    const observedEpoch = this.getState(input.instanceId).epoch;
    this.enqueue(input.instanceId, async () => {
      if (this.getState(input.instanceId).epoch !== observedEpoch) return;
      await this.evaluate(input, requestCount);
    });
  }

  async drain(instanceId: string): Promise<void> {
    await this.queueTails.get(instanceId);
  }

  recordObservedCompaction(instanceId: string, usage: ContextUsage | undefined, cumulativeTokens = 0): void {
    const state = this.states.get(instanceId);
    if (!state) return;
    const nextState = this.policy.advanceEpoch(state, 'compaction-observed', cumulativeTokens);
    this.states.set(instanceId, nextState);
    this.record(instanceId, usage, {
      eventKind: 'proof-boundary',
      recoveryEpoch: nextState.epoch,
      actionCode: 'native-compaction',
      proofStage: 'observed',
    });
  }

  recordProviderActionProof(
    instanceId: string,
    usage: ContextUsage | undefined,
    actionCode: string,
    proofStage: 'requested' | 'acknowledged' | 'observed',
  ): void {
    this.record(instanceId, usage, {
      eventKind: 'action-proof',
      recoveryEpoch: this.getState(instanceId).epoch,
      actionCode,
      proofStage,
    });
  }

  cleanup(instanceId: string): void {
    this.states.delete(instanceId);
    this.queueTails.delete(instanceId);
    this.requestCounts.delete(instanceId);
    this.lastCumulativeTokens.delete(instanceId);
    for (const key of this.proofStages) {
      if (key.startsWith(`${instanceId}:`)) this.proofStages.delete(key);
    }
  }

  private getState(instanceId: string): ContextSafetyPolicyState {
    let state = this.states.get(instanceId);
    if (!state) {
      state = createInitialContextSafetyPolicyState(`instance:${instanceId}`);
      this.states.set(instanceId, state);
    }
    return state;
  }

  private observeCounterReset(instanceId: string, usage: ContextUsage): void {
    const cumulative = usage.cumulativeTokens;
    if (typeof cumulative !== 'number' || !Number.isFinite(cumulative)) return;
    const previous = this.lastCumulativeTokens.get(instanceId);
    this.lastCumulativeTokens.set(instanceId, cumulative);
    if (previous === undefined || cumulative >= previous) return;
    const nextState = this.policy.advanceEpoch(
      this.getState(instanceId),
      'provider-counter-reset-observed',
      cumulative,
    );
    this.states.set(instanceId, nextState);
    this.record(instanceId, usage, {
      eventKind: 'proof-boundary',
      recoveryEpoch: nextState.epoch,
      actionCode: 'provider-counter-reset',
      proofStage: 'observed',
    });
  }

  private enqueue(instanceId: string, operation: () => Promise<void>): void {
    const previous = this.queueTails.get(instanceId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const tail = pending.catch(() => undefined);
    this.queueTails.set(instanceId, tail);
    void tail.finally(() => {
      if (this.queueTails.get(instanceId) === tail) this.queueTails.delete(instanceId);
    });
  }

  private async evaluate(input: ContextPolicyObservation, providerRequestCount: number): Promise<void> {
    const state = this.getState(input.instanceId);
    const sample = buildPressureSample(input.usage, state.epoch, providerRequestCount);
    const decision = this.policy.decide({
      sample,
      capabilities: input.capabilities,
      state,
      now: Date.now(),
      effectiveWindowTokens: input.usage.total,
      atSafeProviderBoundary: true,
    });
    this.states.set(input.instanceId, decision.nextState);
    if (decision.action.kind === 'none' && decision.reasonCode === 'NO_ACTION') return;
    const base = {
      recoveryEpoch: decision.action.recoveryEpoch,
      thresholdCode: decision.action.trigger,
      actionCode: decision.action.kind,
    };
    this.record(input.instanceId, input.usage, { eventKind: 'decision', ...base });
    if (input.mode !== 'enforce' || !input.autoCompactEnabled) return;
    if (!isExecutableProviderAction(decision.action.kind)) return;
    if (input.circuitBreakerTripped) {
      this.record(input.instanceId, input.usage, {
        eventKind: 'action-proof', ...base, failureCode: 'CIRCUIT_BREAKER_TRIPPED',
      });
      return;
    }
    this.record(input.instanceId, input.usage, {
      eventKind: 'action-proof', ...base, proofStage: 'requested',
    });
    if (!input.executor) {
      this.record(input.instanceId, input.usage, {
        eventKind: 'action-proof', ...base, failureCode: 'ACTION_EXECUTOR_UNAVAILABLE',
      });
      return;
    }
    const result = await input.executor.execute(decision.action.kind);
    if (result.status !== 'executed') {
      input.onActionFailure();
      this.record(input.instanceId, input.usage, {
        eventKind: 'action-proof', ...base, failureCode: result.errorCode,
      });
      return;
    }
    input.onActionSuccess();
    if (result.proof !== 'none' && result.proof !== 'requested') {
      this.record(input.instanceId, input.usage, {
        eventKind: 'action-proof', ...base, proofStage: result.proof,
      });
    }
    if (result.proof === 'observed' && decision.action.kind === 'native-compaction') {
      const currentState = this.getState(input.instanceId);
      if (currentState.epoch === decision.action.recoveryEpoch) {
        this.states.set(input.instanceId, this.policy.advanceEpoch(
          currentState,
          'compaction-observed',
          input.usage.cumulativeTokens ?? 0,
        ));
      }
    }
  }

  private record(
    instanceId: string,
    usage: ContextUsage | undefined,
    event: Pick<ContextPolicyEvent,
      'eventKind' | 'recoveryEpoch' | 'thresholdCode' | 'actionCode' | 'proofStage' | 'failureCode'>,
  ): void {
    if (event.eventKind === 'action-proof' && event.proofStage) {
      const key = [instanceId, event.recoveryEpoch, event.actionCode ?? 'unknown', event.proofStage].join(':');
      if (this.proofStages.has(key)) return;
      this.proofStages.add(key);
    }
    this.publish({
      instanceId,
      ...event,
      ...(usage && Number.isFinite(usage.used) ? { occupancyUsed: usage.used } : {}),
      ...(usage && Number.isFinite(usage.total) ? { occupancyTotal: usage.total } : {}),
      ...(usage && typeof usage.cumulativeTokens === 'number' ? { cumulativeTokens: usage.cumulativeTokens } : {}),
      outputBytes: 0,
      providerRequestCount: this.requestCounts.get(instanceId) ?? 0,
      newEvidenceCount: 0,
      newFindingCount: 0,
      createdAt: Date.now(),
    });
  }
}

function buildPressureSample(
  usage: ContextUsage,
  recoveryEpoch: number,
  providerRequestCount: number,
): ContextPressureSample {
  return {
    occupancy: Number.isFinite(usage.used) && Number.isFinite(usage.total) && usage.total > 0
      ? { status: 'known', used: usage.used, total: usage.total }
      : { status: 'unknown', reason: 'provider-occupancy-unavailable' },
    ...(typeof usage.cumulativeTokens === 'number' && Number.isFinite(usage.cumulativeTokens)
      ? { cumulativeTokens: usage.cumulativeTokens } : {}),
    outputBytesSinceCompaction: 0,
    providerRequestCount,
    newEvidenceCount: 0,
    newValidatedFindingCount: 0,
    recoveryEpoch,
  };
}

function isExecutableProviderAction(action: string): action is ProviderContextExecutableAction {
  return action === 'rebuild-working-set' || action === 'native-compaction'
    || action === 'controlled-interrupt' || action === 'controlled-recovery'
    || action === 'same-thread-continuation';
}
