import { describe, expect, it, vi } from 'vitest';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';

import { CodexContextCostController } from '../cli/adapters/codex/context-cost-controller';
import { CompactionCoordinator, type ContextPolicyEvent } from '../context/compaction-coordinator';
import { ProviderContextActionExecutor } from './provider-context-action-executor';

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
      used: 10,
      total: 100,
      percentage: 10,
      cumulativeTokens: 400,
    });
    await coordinator.drainPolicyDecisions('codex-1');

    expect(recovery).toHaveBeenCalledOnce();
    expect(interrupt).not.toHaveBeenCalled();
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
});
