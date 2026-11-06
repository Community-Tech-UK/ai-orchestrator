import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';
import { subscribeCostAttribution } from '../core/system/cost-attribution';
import { bindRawAdapterProviderEvents } from './instance-communication-provider-events';

const instance = { id: 'instance-1', sessionId: 'session-1' } as Instance;

function record(sample: Record<string, unknown>): Record<string, unknown> | undefined {
  const adapter = new EventEmitter() as CliAdapter;
  const records: Record<string, unknown>[] = [];
  const unsubscribe = subscribeCostAttribution((entry) => records.push(entry as unknown as Record<string, unknown>));
  bindRawAdapterProviderEvents({ adapter, isStale: () => false, emit: vi.fn(), getInstance: () => instance });
  adapter.emit('subagent_usage', { toolUseId: 'toolu_1', finalContextTokens: 90_000, toolUses: 4, durationMs: 1_500, final: true, ...sample });
  unsubscribe();
  return records[0];
}

describe('finished Claude helper record', () => {
  it('carries the model it ran and how it was started', () => {
    expect(record({
      model: 'claude-sonnet-5-5', modelSource: 'stream', agentType: 'general-purpose', fork: false, depth: 2, mode: 'background',
      description: 'must not be stored',
    })).toMatchObject({
      purpose: 'subagent', provider: 'claude', model: 'claude-sonnet-5-5', helperModelSource: 'stream',
      helperAgentType: 'general-purpose', helperFork: false, helperDepth: 2, helperMode: 'background',
      costSource: 'unknown', costKnown: false, finalContextTokens: 90_000,
    });
  });

  it('adds nothing when the helper details are unknown', () => {
    const entry = record({});
    expect(entry).toMatchObject({ purpose: 'subagent', finalContextTokens: 90_000 });
    for (const key of ['model', 'helperModelSource', 'helperAgentType', 'helperFork', 'helperDepth', 'helperMode', 'description']) {
      expect(entry).not.toHaveProperty(key);
    }
  });
});
