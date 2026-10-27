import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { AutomationRunner } from './automation-runner';
import type { AutomationStore } from './automation-store';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import { recordInstanceTurnAttribution, subscribeCostAttribution, type CostAttributionRecord } from '../core/system/cost-attribution';

vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
// The account rules read settings; their own spec covers them.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn() }) }));

describe('automation spend attribution', () => {
  it('files a real automation-created instance turn as automation', async () => {
    const records: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    let spawned: { metadata?: Record<string, unknown> } | undefined;
    const manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async (config: { metadata?: Record<string, unknown> }) => {
        spawned = config;
        return { id: 'automation-instance', status: 'initializing', outputBuffer: [] };
      }),
    });
    const store = { failRunningRuns: () => [], listRunningLoopLinkedRuns: () => [], attachInstance: () => undefined };
    const runner = new AutomationRunner(store as unknown as AutomationStore, undefined, () => 1000,
      (() => ({})) as never, undefined, undefined, () => ({ provider: 'claude', model: 'haiku' }) as never, () => false);
    runner.initialize(manager as unknown as InstanceManager);
    try {
      await runner.dispatchRetryRun({ id: 'run-example', automationId: 'automation-example', attempt: 2,
        configSnapshot: { name: 'Example', destination: { kind: 'newInstance' }, action: { prompt: 'Example prompt', workingDirectory: '/repo', provider: 'claude' } },
      } as unknown as AutomationRun);
      expect(manager.createInstance).toHaveBeenCalledOnce();
      expect(spawned?.metadata?.['spendPurpose']).toBe('automation');
      recordInstanceTurnAttribution({ instanceId: 'automation-instance', usage: { inputTokens: 10 }, costKnown: false,
        spendPurpose: spawned?.metadata?.['spendPurpose'] as 'automation' });
      expect(records).toHaveLength(1);
      expect(records[0]?.purpose).toBe('automation');
    } finally { stop(); }
  });
});
