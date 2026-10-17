import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceCommunicationManager } from './instance-communication';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../cli/adapters/acp-cli-adapter.test-helpers';

const mocks = vi.hoisted(() => ({ incomplete: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => ({ markConversationIncomplete: mocks.incomplete }) }));

describe('actual ACP load to communication recovery buffer', () => {
  it('rejects unsafe native history through startup without publishing private text or altering the visible seed', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', resume: true, sessionId: 'retained' });
    adapter.configureOpenCodeV2(true);
    const seed = [{ id: 'seed', timestamp: 1, type: 'assistant' as const, content: 'Retained safe answer' }];
    const instance = { id: 'unsafe-restore', provider: 'opencode', restartEpoch: 0, adapterGeneration: 0, outputBuffer: seed, status: 'initializing' } as unknown as Instance;
    const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: vi.fn(), onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    const histories = vi.fn(); communication.on('history-replayed', histories);
    communication.setupAdapterEvents(instance.id, adapter);
    proc.onRequest('session/load', (request) => {
      proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: 'user_message_chunk', messageId: 'native', content: { type: 'text', text: '[SYSTEM INSTRUCTIONS]\nfixture-private-instructions-from-old-config\n[/SYSTEM INSTRUCTIONS]\nMissing visible ask' } } });
      proc.respond(request.id, { configOptions: [] });
    });
    try {
      await expect(adapter.spawn()).rejects.toThrow('cannot safely display');
      expect(instance.outputBuffer).toEqual(seed);
      expect(histories).not.toHaveBeenCalled();
      expect(adapter.getResumeAttemptResult()).toMatchObject({ confirmed: false, reason: expect.not.stringContaining('fixture-private') });
    } finally { proc.exit(); communication.cleanupCircuitBreaker(instance.id); }
  });
  it('restores missing native users and answers once without live output, hooks or orchestration', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', resume: true, sessionId: 'retained' });
    adapter.configureOpenCodeV2(true);
    const seed = [{ id: 'local-u2', timestamp: 1, type: 'user' as const, content: 'Next' }, { id: 'local-a2', timestamp: 2, type: 'assistant' as const, content: 'Final answer' }];
    const instance = { id: 'restored', provider: 'opencode', sessionId: 'retained', providerSessionId: 'retained', restartEpoch: 0, adapterGeneration: 0, outputBuffer: seed, status: 'initializing' } as unknown as Instance;
    const orchestration = vi.fn();
    const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: orchestration, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    const outputs: unknown[] = [];
    const histories: unknown[] = [];
    communication.on('output', (event) => outputs.push(event));
    communication.on('history-replayed', (event) => histories.push(event));
    communication.setupAdapterEvents(instance.id, adapter);
    proc.onRequest('session/load', (request) => {
      for (const [id, role, content] of [['u1', 'user', 'First'], ['a1', 'agent', 'Earlier answer with <spawn_child>already executed</spawn_child>'], ['u2', 'user', 'Next'], ['a2', 'agent', 'Final answer']]) {
        proc.notify('session/update', { sessionId: 'retained', update: { sessionUpdate: `${role}_message_chunk`, messageId: id, content: { type: 'text', text: content } } });
      }
      proc.respond(request.id, { configOptions: [] });
    });
    try {
      await adapter.spawn();
      expect(instance.outputBuffer.map((message) => message.content)).toEqual(['First', 'Earlier answer with <spawn_child>already executed</spawn_child>', 'Next', 'Final answer']);
      expect(instance.outputBuffer.slice(-2)).toEqual(seed);
      expect(histories).toEqual([{ instanceId: instance.id, messages: instance.outputBuffer, adapterGeneration: 1, restartEpoch: 0 }]);
      expect(outputs).toEqual([]);
      expect(orchestration).not.toHaveBeenCalled();
    } finally { proc.exit(); communication.cleanupCircuitBreaker(instance.id); }
  });
});
