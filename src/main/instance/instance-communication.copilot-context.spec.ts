import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
import { InstanceCommunicationManager } from './instance-communication';

function fixture() {
  const instance = {
    id: 'context-worker', sessionId: 'context-provider', provider: 'copilot',
    parentId: 'queue-owner', status: 'idle', restartEpoch: 0,
    contextUsage: { used: 0, total: 1000, percentage: 0 },
  } as Instance;
  const adapter = Object.assign(new EventEmitter(), { getName: () => 'copilot-acp' }) as CliAdapter;
  let currentAdapter = adapter;
  const events: ProviderRuntimeEvent[] = [];
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => currentAdapter,
    setAdapter: (_id, replacement) => { currentAdapter = replacement; },
    deleteAdapter: () => false, queueUpdate: vi.fn(),
    processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
    emitProviderRuntimeEvent: (_id, event) => events.push(event),
  });
  manager.setupAdapterEvents(instance.id, adapter);
  const emit = (details: Record<string, unknown>) => {
    adapter.emit('context', { used: 25, total: 1000, percentage: 2.5, ...details });
    return events.at(-1);
  };
  return { manager, instance, adapter, events, emit };
}

describe('InstanceCommunication normalized Copilot context', () => {
  it('preserves measured zero in premium, compaction and token counters', () => {
    const f = fixture();
    const copilotUsage = { premiumRequests: 0, compactions: 0, postCompactionTokens: 0, tokenLimit: 1000 };
    expect(f.emit({ copilotUsage })).toEqual({
      kind: 'context', used: 25, total: 1000, percentage: 2.5,
      occupancyReported: true, copilotUsage,
    });
  });

  it('projects only validated numeric evidence and preserves ordinary context fields', () => {
    const f = fixture();
    const copilotUsage = {
      premiumRequests: 1.5, compactions: 2, postCompactionTokens: 901, tokenLimit: 1000,
      prompt: 'Provider prompt text', response: 'Provider response text',
      account: 'Provider account text', nested: { content: 'Provider body' },
    };
    const event = f.emit({ copilotUsage, inputTokens: 20, outputTokens: 5, source: 'provider-usage', promptWeight: 0.02 });
    expect(event).toEqual({
      kind: 'context', used: 25, total: 1000, percentage: 2.5, occupancyReported: true,
      inputTokens: 20, outputTokens: 5, source: 'provider-usage', promptWeight: 0.02,
      copilotUsage: { premiumRequests: 1.5, compactions: 2, postCompactionTokens: 901, tokenLimit: 1000 },
    });
    copilotUsage.compactions = 99;
    expect(event?.kind === 'context' && event.copilotUsage?.compactions).toBe(2);
  });

  it.each([
    ['absent', undefined], ['null', null], ['text', 'provider text'], ['empty', {}],
    ['string count', { compactions: '2' }], ['fractional count', { compactions: 1.5 }],
    ['negative count', { compactions: -1 }], ['nonfinite count', { compactions: Infinity }],
    ['negative premium', { compactions: 0, premiumRequests: -1 }],
    ['nonfinite premium', { compactions: 0, premiumRequests: NaN }],
    ['string tokens', { compactions: 0, postCompactionTokens: '901' }],
    ['zero limit', { compactions: 0, tokenLimit: 0 }],
  ])('omits %s evidence without inventing a measured zero', (_name, copilotUsage) => {
    const f = fixture();
    // First prove an earlier valid measurement cannot leak into a later invalid event.
    f.emit({ copilotUsage: { compactions: 1 } });
    expect(f.emit(copilotUsage === undefined ? {} : { copilotUsage })).toEqual({
      kind: 'context', used: 25, total: 1000, percentage: 2.5, occupancyReported: true,
    });
  });

  it('ignores context from a replaced adapter on the actual listener path', () => {
    const f = fixture();
    f.manager.setupAdapterEvents(f.instance.id, new EventEmitter() as CliAdapter);
    f.emit({ copilotUsage: { compactions: 2, postCompactionTokens: 901, tokenLimit: 1000 } });
    expect(f.events).toEqual([]);
  });
});
