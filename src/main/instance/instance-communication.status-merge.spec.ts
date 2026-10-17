import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { InstanceCommunicationManager } from './instance-communication';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../cli/adapters/acp-cli-adapter.test-helpers';
import { appendInstanceOutputMessage } from '../../renderer/app/core/state/instance/instance-output-message-merge';
import { toOutputMessageFromProviderOutputEvent, toProviderOutputEvent } from '../providers/provider-output-event';
import { buildRetryRecoveredMessage } from '../cli/adapters/acp-retry-state';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'text' }) }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 0 }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));

async function harness() {
  const proc = createInitializedAgentHarness();
  const adapter = new TestAcpCliAdapter(proc, { command: process.execPath, workingDirectory: '/tmp' });
  adapter.configureOpenCodeV2(true);
  const instance = { id: 'status-fixture', provider: 'opencode', sessionId: 'sess-acp-1',
    providerSessionId: 'sess-acp-1', restartEpoch: 0, adapterGeneration: 0, outputBuffer: [],
    status: 'initializing', contextUsage: { used: 0, total: 1000, percentage: 0 } } as unknown as Instance;
  const ingested: OutputMessage[] = [];
  const progress: string[] = [];
  const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
    setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
    processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
    ingestToRLM: (_id, message) => ingested.push(message), ingestToUnifiedMemory: () => undefined,
    onOutput: (_id, content) => { if (content) progress.push(content); } });
  const visible: OutputMessage[] = [];
  communication.on('output', ({ message }: { message: OutputMessage }) => {
    appendInstanceOutputMessage(visible, toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(message)), new Set());
  });
  communication.setupAdapterEvents(instance.id, adapter);
  await adapter.spawn();
  const update = (value: Record<string, unknown>): void => proc.notify('session/update', { sessionId: 'sess-acp-1', update: value });
  const status = (source: string): OutputMessage[] => instance.outputBuffer.filter(message => message.metadata?.['source'] === source);
  const finish = async (): Promise<void> => {
    proc.exit();
    await Promise.resolve();
    communication.cleanupCircuitBreaker(instance.id);
  };
  return { proc, adapter, instance, communication, visible, ingested, progress, update, status, finish };
}

describe('ACP status updates through the main buffer and ordinary renderer merge', () => {
  it.each([
    ['completed', 'Compaction completed.'],
    ['failed', 'Compaction failed.'],
  ])('replaces a compacting notice with its %s result', async (phase, expected) => {
    const h = await harness();
    try {
      h.update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: 'in_progress' });
      h.update({ sessionUpdate: 'compaction_update', compactionId: 'compact-1', status: phase });
      expect(h.status('acp-compaction').map(message => [message.content, message.metadata?.['phase'], message.metadata?.['streaming']]))
        .toEqual([[expected, phase, false]]);
      expect(h.visible.map(message => message.content)).toEqual([expected]);
      // Updates replace a record; only the first record enters context ingestion.
      expect(h.ingested).toHaveLength(1);
      expect(h.progress).toEqual(['Compacting the session…', expected]);
    } finally { await h.finish(); }
  });

  it('updates a shorter intermediate retry status before recovery, with one notice per turn', async () => {
    const h = await harness();
    let attempt = 0;
    h.proc.onRequest('session/prompt', request => {
      attempt++;
      h.update({ sessionUpdate: 'usage_update', _meta: { 'opencode/retry': { attempt: 1, error: { status: 429 } } } });
      h.update({ sessionUpdate: 'usage_update', _meta: { 'opencode/retry': { attempt: 2 } } });
      expect(h.status('acp-retry-state').at(-1)?.content).toBe('Provider hit an error and is retrying (attempt 2).');
      expect(h.visible.at(-1)?.content).toBe('Provider hit an error and is retrying (attempt 2).');
      h.proc.respond(request.id, { stopReason: 'end_turn' });
    });
    try {
      await h.adapter.sendMessage({ role: 'user', content: 'first turn' });
      await h.adapter.sendMessage({ role: 'user', content: 'second turn' });
      const statuses = h.status('acp-retry-state');
      expect(attempt).toBe(2);
      expect(statuses.map(message => [message.content, message.metadata?.['phase'], message.metadata?.['streaming']]))
        .toEqual([['Provider recovered after retrying.', 'recovered', false], ['Provider recovered after retrying.', 'recovered', false]]);
      expect(new Set(statuses.map(message => message.id)).size).toBe(2);
      expect(h.visible.filter(message => message.metadata?.['source'] === 'acp-retry-state').map(message => message.content))
        .toEqual(['Provider recovered after retrying.', 'Provider recovered after retrying.']);
    } finally { await h.finish(); }
  });

  it.each([
    ['ended', false, 'Provider request ended after retrying.'],
    ['exhausted', true, 'Provider gave up retrying: Provider returned HTTP 429.'],
  ])('replaces retry text when the request is %s', async (_phase, exhausted, expected) => {
    const h = await harness();
    h.proc.onRequest('session/prompt', request => {
      h.update({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 1, max_retries: 15, reason: 'Provider returned HTTP 429.' });
      if (exhausted) h.update({ sessionUpdate: 'retry_state', type: 'exhausted', reason: 'Provider returned HTTP 429.' });
      h.proc.respondError(request.id, -32003, 'Fixture request failed');
    });
    try {
      await expect(h.adapter.sendMessage({ role: 'user', content: 'request' })).rejects.toThrow('Fixture request failed');
      expect(h.status('acp-retry-state').map(message => message.content)).toEqual([expected]);
      expect(h.status('acp-retry-state')[0].metadata?.['streaming']).toBe(false);
      expect(h.visible.find(message => message.metadata?.['source'] === 'acp-retry-state')?.content).toBe(expected);
    } finally { await h.finish(); }
  });

  it('keeps separate compactions separate and coalesces repeated terminal updates', async () => {
    const h = await harness();
    try {
      for (const id of ['compact-1', 'compact-2']) {
        h.update({ sessionUpdate: 'compaction_update', compactionId: id, status: 'started' });
        h.update({ sessionUpdate: 'compaction_update', compactionId: id, status: 'completed' });
        h.update({ sessionUpdate: 'compaction_update', compactionId: id, status: 'completed' });
      }
      expect(h.status('acp-compaction').map(message => message.content)).toEqual(['Compaction completed.', 'Compaction completed.']);
      expect(new Set(h.visible.map(message => message.id)).size).toBe(2);
    } finally { await h.finish(); }
  });

  it('keeps the same provider compaction key separate across prompt turns', async () => {
    const h = await harness();
    h.proc.onRequest('session/prompt', request => {
      h.update({ sessionUpdate: 'compaction_update', compactionId: 'reused-key', status: 'started' });
      h.update({ sessionUpdate: 'compaction_update', compactionId: 'reused-key', status: 'completed' });
      h.proc.respond(request.id, { stopReason: 'end_turn' });
    });
    try {
      await h.adapter.sendMessage({ role: 'user', content: 'first turn' });
      await h.adapter.sendMessage({ role: 'user', content: 'second turn' });
      expect(h.status('acp-compaction').map(message => message.content)).toEqual(['Compaction completed.', 'Compaction completed.']);
      expect(new Set(h.status('acp-compaction').map(message => message.id)).size).toBe(2);
    } finally { await h.finish(); }
  });

  it.each(['assistant', 'system'] as const)('preserves %s text and existing thinking against shorter final snapshots', async type => {
    const h = await harness();
    try {
      const answer: OutputMessage = { id: 'answer', timestamp: 1, type, content: 'The complete useful answer.',
        metadata: { streaming: true, source: 'unrelated-stream' }, thinking: [{ id: 'reasoning', content: 'The complete reasoning.', format: 'structured' }] };
      h.adapter.emit('output', answer);
      h.adapter.emit('output', { ...answer, content: 'The', metadata: { streaming: false, accumulatedContent: 'The', source: 'unrelated-stream' },
        thinking: undefined });
      expect(h.instance.outputBuffer[0].content).toBe('The complete useful answer.');
      expect(h.instance.outputBuffer[0].thinking?.[0].content).toBe('The complete reasoning.');
      expect(h.visible[0].content).toBe('The complete useful answer.');
      expect(h.visible[0].thinking?.[0].content).toBe('The complete reasoning.');
      expect(h.visible[0].metadata?.['streaming']).toBe(false);
    } finally { await h.finish(); }
  });

  it.each(['assistant', 'system'] as const)('does not replace unrelated %s content when a status notice reuses its ID', async type => {
    const h = await harness();
    try {
      h.adapter.emit('output', { id: 'collision', timestamp: 1, type, content: 'Original complete committed content.',
        metadata: { streaming: true, source: type === 'system' ? 'unrelated-status' : 'acp-retry-state' } });
      h.adapter.emit('output', buildRetryRecoveredMessage('collision'));
      expect(h.instance.outputBuffer[0].content).toBe('Original complete committed content.');
      expect(h.visible[0].content).toBe('Original complete committed content.');
      expect(h.instance.outputBuffer[0].type).toBe(type);
      expect(h.visible[0].type).toBe(type);
      expect(h.instance.outputBuffer[0].metadata?.['source']).toBe(type === 'system' ? 'unrelated-status' : 'acp-retry-state');
      expect(h.visible[0].metadata?.['source']).toBe(type === 'system' ? 'unrelated-status' : 'acp-retry-state');
      expect(h.instance.outputBuffer[0].metadata?.['streaming']).toBe(true);
      expect(h.visible[0].metadata?.['streaming']).toBe(true);
    } finally { await h.finish(); }
  });
});
