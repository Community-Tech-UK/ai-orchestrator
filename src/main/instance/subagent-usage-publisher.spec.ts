import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { subscribeSubagentUsage } from './subagent-usage-publisher';
import { bindRawAdapterProviderEvents } from './instance-communication-provider-events';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';
describe('helper live push throttling', () => {
  it('throttles running samples but always publishes final size with numeric fields only', () => {
    vi.useFakeTimers();
    const adapter = new EventEmitter() as CliAdapter;
    const listener = vi.fn(); const cleanup = subscribeSubagentUsage(listener);
    let stale = false;
    bindRawAdapterProviderEvents({ adapter, isStale: () => stale, emit: vi.fn(), getInstance: () => ({ id: 'i', sessionId: 's' } as Instance) });
    const sample = { toolUseId: 'task', finalContextTokens: 1000, toolUses: 1, durationMs: 100, final: false, description: 'not forwarded' };
    try {
      adapter.emit('subagent_usage', sample); adapter.emit('subagent_usage', sample);
      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000); adapter.emit('subagent_usage', sample);
      adapter.emit('subagent_usage', { ...sample, final: true });
      expect(listener).toHaveBeenCalledTimes(3);
      expect(listener.mock.calls[2][0]).toEqual({ instanceId: 'i', toolUseId: 'task', finalContextTokens: 1000, toolUses: 1, durationMs: 100, final: true });
      stale = true; adapter.emit('subagent_usage', { ...sample, toolUseId: 'other' });
      expect(listener).toHaveBeenCalledTimes(3);
    } finally { cleanup(); vi.useRealTimers(); }
  });
});
