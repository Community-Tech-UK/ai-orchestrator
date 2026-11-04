import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { AutomationRunLimits } from './automation-run-limits';
import { AutomationLoopRunLimits } from './automation-loop-run-limits';

// The plan Step7.1 and backlog K3.2 define processed=input+cacheRead+cacheWrite.
// Step9.2 uses that metric. Output remains separate, including for cap accounting.
const run: AutomationRun = {
  id: 'run', automationId: 'job', status: 'running', trigger: 'manual', scheduledAt: 1, startedAt: 1,
  finishedAt: null, instanceId: 'root', loopRunId: null, error: null, outputSummary: null, outputFullRef: null,
  idempotencyKey: null, triggerSource: null, deliveryMode: 'localOnly', seenAt: null,
  createdAt: 1, updatedAt: 1, attempt: 1, maxAttempts: 1,
  configSnapshot: { name: 'Fixture', schedule: { type: 'oneTime', runAt: 1 }, trigger: { kind: 'schedule' },
    missedRunPolicy: 'skip', concurrencyPolicy: 'skip', destination: { kind: 'newInstance' },
    action: { prompt: 'Fixture', workingDirectory: '/fixture', maxRunMinutes: 90, maxProcessedTokens: 100 } },
};
function complete(instanceId: string, seq: number, input: number, output: number, cacheRead: number, cacheWrite: number): ProviderRuntimeEventEnvelope {
  return { eventId: `fixture-${seq}`, seq, timestamp: 1, provider: 'claude', instanceId,
    event: { kind: 'complete', inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite } };
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const clear of cleanup.splice(0)) clear(); });

describe('canonical scheduled processed-token cap', () => {
  it('keeps output separate from input and both caches for an ordinary run', () => {
    const stopped = vi.fn(); const observed: number[] = [];
    const limits = new AutomationRunLimits({ getInstance: () => undefined, getAllInstances: () => [], terminateInstance: async () => undefined },
      () => 1, stopped, (_run, _instance, _source, amount) => { observed.push(amount); return observed.reduce((sum, value) => sum + value, 0); }, vi.fn(), vi.fn());
    cleanup.push(() => limits.clear('root')); limits.track('root', run);
    limits.observe('root', complete('root', 1, 1, 101, 2, 3));
    expect(observed).toEqual([6]);
    expect(stopped).not.toHaveBeenCalled();
    limits.observe('root', complete('root', 2, 0, 0, 95, 0));
    expect(observed).toEqual([6, 95]);
    expect(stopped).toHaveBeenCalledWith('root', 'Stopped: token cap');
  });
  it('uses the same processed metric for loop-owned invocations', () => {
    const stopped = vi.fn(); const observed: number[] = [];
    const limits = new AutomationLoopRunLimits(() => 1, stopped,
      (_run, _instance, _source, amount) => { observed.push(amount); return observed.reduce((sum, value) => sum + value, 0); });
    cleanup.push(() => limits.clear('loop')); limits.track('loop', run);
    const id = 'automation:job:run';
    limits.observe(complete(id, 1, 1, 101, 2, 3));
    expect(observed).toEqual([6]);
    expect(stopped).not.toHaveBeenCalled();
    limits.observe(complete(id, 2, 0, 0, 95, 0));
    expect(observed).toEqual([6, 95]);
    expect(stopped).toHaveBeenCalledWith('loop', 'Stopped: token cap', expect.any(Object));
  });
});
