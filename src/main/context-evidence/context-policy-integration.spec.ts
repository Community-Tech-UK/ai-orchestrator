import { describe, expect, it, vi } from 'vitest';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';

import { CodexContextCostController } from '../cli/adapters/codex/context-cost-controller';
import { CompactionCoordinator, type ContextPolicyEvent } from '../context/compaction-coordinator';
import { ProviderContextActionExecutor } from './provider-context-action-executor';
import type { CumulativeRecoveryLimits } from './context-safety-policy';

const codexObserved: ProviderContextCapabilities = {
  toolResultControl: 'post-retention',
  toolResultVisibility: 'full',
  transcriptControl: 'native-compaction',
  occupancyReporting: 'current',
  cumulativeReporting: 'available',
  interruptProof: 'observed',
  compactionProof: 'observed',
  sameThreadContinuation: true,
};

describe('shared context policy integration', () => {
  it('keeps the Codex controller from independently deciding on the same cumulative sample', async () => {
    CompactionCoordinator._resetForTesting();
    const interrupt = vi.fn(() => ({ status: 'unsupported' as const }));
    const controller = new CodexContextCostController({
      compactionTimeoutMs: 10,
      interrupt,
      getCompactionTarget: () => null,
      emitSystem: vi.fn(),
    });
    controller.observe(400, 100);
    expect(interrupt).not.toHaveBeenCalled();

    const recovery = vi.fn(async () => ({ proof: 'acknowledged' as const }));
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.configure({
      getContextCapabilities: () => codexObserved,
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({
        'controlled-recovery': recovery,
      }),
      selfManagesAutoCompaction: () => true,
    });

    coordinator.onContextUpdate('codex-1', {
      used: 55,
      total: 100,
      percentage: 55,
      cumulativeTokens: 400,
    });
    await coordinator.drainPolicyDecisions('codex-1');

    expect(recovery).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('applies the configured spend-recovery limits to shared policy decisions', async () => {
    const recoveriesAtTenPercent = async (limits?: CumulativeRecoveryLimits) => {
      CompactionCoordinator._resetForTesting();
      const recovery = vi.fn(async () => ({ proof: 'acknowledged' as const }));
      const coordinator = CompactionCoordinator.getInstance();
      coordinator.configure({
        getContextCapabilities: () => codexObserved,
        getContextEvidenceMode: () => 'enforce',
        getProviderActionExecutor: () => new ProviderContextActionExecutor({
          'controlled-recovery': recovery,
        }),
        selfManagesAutoCompaction: () => true,
      });
      if (limits) coordinator.setCumulativeRecoveryLimits(limits);
      coordinator.onContextUpdate('codex-limits', {
        used: 10, total: 100, percentage: 10, cumulativeTokens: 400,
      });
      await coordinator.drainPolicyDecisions('codex-limits');
      return recovery.mock.calls.length;
    };

    expect(await recoveriesAtTenPercent()).toBe(0);
    expect(await recoveriesAtTenPercent({ minOccupancyPercent: 0, backstopMultiple: 16 })).toBe(1);
    // A non-finite floor falls back to the default rather than disabling it.
    expect(await recoveriesAtTenPercent({ minOccupancyPercent: Number.NaN, backstopMultiple: 16 })).toBe(0);
  });

  it('records one content-free decision and distinct proof stages per threshold and epoch', async () => {
    CompactionCoordinator._resetForTesting();
    const events: ContextPolicyEvent[] = [];
    const nativeCompaction = vi.fn(async () => ({ proof: 'observed' as const }));
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.configure({
      getContextCapabilities: () => codexObserved,
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({
        'native-compaction': nativeCompaction,
      }),
      recordPolicyEvent: (event) => { events.push(event); },
      getAtSafeProviderBoundary: () => true,
    });

    const pressure = { used: 75, total: 100, percentage: 75, cumulativeTokens: 75 };
    coordinator.onContextUpdate('codex-2', pressure);
    coordinator.onContextUpdate('codex-2', pressure);
    await coordinator.drainPolicyDecisions('codex-2');

    expect(nativeCompaction).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.eventKind === 'decision')).toHaveLength(1);
    expect(events.filter((event) => event.proofStage === 'requested')).toHaveLength(1);
    expect(events.filter((event) => event.proofStage === 'observed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/content|message|threadId|prompt/i);
  });

  it('steers a live Codex turn at 75% instead of compacting', async () => {
    CompactionCoordinator._resetForTesting();
    const nativeCompaction = vi.fn(async () => ({ proof: 'observed' as const }));
    const steer = vi.fn(async () => ({ proof: 'acknowledged' as const }));
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.configure({
      getContextCapabilities: () => codexObserved,
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({
        'native-compaction': nativeCompaction,
        'steer-turn': steer,
      }),
      getAtSafeProviderBoundary: () => false,
    });

    coordinator.onContextUpdate('codex-live', {
      used: 75, total: 100, percentage: 75, cumulativeTokens: 75,
    });
    await coordinator.drainPolicyDecisions('codex-live');

    expect(steer).toHaveBeenCalledOnce();
    expect(nativeCompaction).not.toHaveBeenCalled();
  });

  // W6 item 3. Each 80% recovery ends in an observed compaction, which starts a
  // new epoch and clears the emitted triggers. Before the fix nothing bounded
  // how often one user send could go round interrupt -> compact -> continue.
  it('caps 80% recoveries per outer user send and restores the allowance on the next send', async () => {
    CompactionCoordinator._resetForTesting();
    const events: ContextPolicyEvent[] = [];
    const interrupt = vi.fn(async () => ({ proof: 'acknowledged' as const }));
    let outerSendId = 'send-1';
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.configure({
      getContextCapabilities: () => codexObserved,
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({
        'controlled-interrupt': interrupt,
      }),
      recordPolicyEvent: (event) => { events.push(event); },
      getAtSafeProviderBoundary: () => false,
      getOuterSendId: () => outerSendId,
    });
    const refillAndCompact = async () => {
      coordinator.onContextUpdate('codex-loop', { used: 85, total: 100, percentage: 85 });
      await coordinator.drainPolicyDecisions('codex-loop');
      coordinator.recordObservedCompaction('codex-loop');
    };

    for (let round = 0; round < 5; round += 1) await refillAndCompact();
    expect(interrupt).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event.eventKind === 'decision' && event.actionCode === 'pause'))
      .toHaveLength(2);

    outerSendId = 'send-2';
    await refillAndCompact();
    expect(interrupt).toHaveBeenCalledTimes(4);
  });

  // W6 item 3. A steer that arrives after the turn finished is a lost race,
  // not a broken provider, so it must not trip the circuit breaker and block
  // later actions.
  it('does not count steers skipped for a finished turn toward the circuit breaker', async () => {
    CompactionCoordinator._resetForTesting();
    const events: ContextPolicyEvent[] = [];
    const tripped = vi.fn();
    const steer = vi.fn(async () => ({ proof: 'none' as const, skipped: 'turn-not-active' as const }));
    const coordinator = CompactionCoordinator.getInstance();
    coordinator.on('compaction-circuit-breaker-tripped', tripped);
    coordinator.configure({
      getContextCapabilities: () => codexObserved,
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({ 'steer-turn': steer }),
      recordPolicyEvent: (event) => { events.push(event); },
      getAtSafeProviderBoundary: () => false,
    });

    for (let round = 0; round < 4; round += 1) {
      coordinator.onContextUpdate('codex-steer', { used: 72, total: 100, percentage: 72 });
      await coordinator.drainPolicyDecisions('codex-steer');
      coordinator.recordObservedCompaction('codex-steer');
    }

    expect(steer).toHaveBeenCalledTimes(4);
    expect(tripped).not.toHaveBeenCalled();
    expect(events.filter((event) => event.failureCode === 'TURN_NOT_ACTIVE')).toHaveLength(4);
    expect(events.some((event) => event.failureCode === 'CIRCUIT_BREAKER_TRIPPED')).toBe(false);
  });
});
