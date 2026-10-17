import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../renderer/app/core/state/instance/instance.types';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { InstanceOutputStore } from '../../renderer/app/core/state/instance/instance-output.store';
import { ImageAttachmentService } from '../../renderer/app/features/instance-detail/image-attachment.service';
import { OpenCodeAcpUpdates } from '../../main/cli/adapters/opencode-acp-updates';
import { buildRetryRecoveredMessage, buildRetryStateMessage } from '../../main/cli/adapters/acp-retry-state';
import { encodeJsonChunks } from '../../shared/utils/json-chunks';

function statusSequence(phase: string): OutputMessage[] {
  if (phase === 'completed' || phase === 'failed') {
    const updates = new OpenCodeAcpUpdates();
    return ['started', 'in_progress', phase].map(status => updates.compaction({
      sessionUpdate: 'compaction_update', compactionId: 'native-compact', status,
    }, () => 'compact-notice')!);
  }
  const start = buildRetryStateMessage({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 1,
    max_retries: 15, reason: 'Provider returned HTTP 429.' }, 'retry-notice');
  const next = buildRetryStateMessage({ sessionUpdate: 'retry_state', type: 'retrying', attempt: 2 }, 'retry-notice');
  const end = phase === 'exhausted'
    ? buildRetryStateMessage({ sessionUpdate: 'retry_state', type: 'exhausted' }, 'retry-notice')
    : buildRetryRecoveredMessage('retry-notice', phase === 'recovered');
  return [start, next, end];
}

describe('live ACP status text in renderer output and racing history replay', () => {
  let state: InstanceStateService;
  let store: InstanceOutputStore;
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [InstanceStateService, InstanceOutputStore,
      { provide: ImageAttachmentService, useValue: { processMessage: vi.fn() } },
      { provide: NgZone, useValue: { run: (fn: () => void) => fn() } }] });
    state = TestBed.inject(InstanceStateService);
    store = TestBed.inject(InstanceOutputStore);
    const instance: Instance = { id: 'status-fixture', displayName: 'Fixture', createdAt: 1,
      historyThreadId: 'fixture-thread', parentId: null, childrenIds: [], agentId: 'build', agentMode: 'build',
      provider: 'opencode', status: 'idle', contextUsage: { used: 0, total: 1000, percentage: 0 },
      lastActivity: 1, providerSessionId: 'fixture-session', sessionId: 'fixture-session', restartEpoch: 0,
      workingDirectory: '/tmp', yoloMode: false, launchMode: 'orchestrated', outputBuffer: [] };
    state.state.set({ instances: new Map([[instance.id, instance]]), selectedInstanceId: null, loading: false, error: null });
  });
  afterEach(() => { store.cleanupAll(); TestBed.resetTestingModule(); });
  const terminalCases = [
    ['completed', 'Compaction completed.'],
    ['failed', 'Compaction failed.'],
    ['recovered', 'Provider recovered after retrying.'],
    ['ended', 'Provider request ended after retrying.'],
    ['exhausted', 'Provider gave up retrying.'],
  ];
  const buffer = (): OutputMessage[] => state.getInstance('status-fixture')!.outputBuffer;
  const queue = (message: OutputMessage): void => { store.queueOutput('status-fixture', message); store.flushInstanceOutput('status-fixture'); };

  it.each(terminalCases)('replaces the live %s notice and keeps one record', (phase, expected) => {
    const messages = statusSequence(phase);
    for (const message of messages) queue(message);
    queue(messages[2]);
    expect(buffer().map(message => [message.content, message.metadata?.['phase'], message.metadata?.['streaming']]))
      .toEqual([[expected, phase, false]]);
    if (phase === 'recovered') {
      queue({ ...messages[0], id: 'next-turn' });
      expect(buffer().map(message => message.id)).toEqual(['retry-notice', 'next-turn']);
      expect(buffer()[0].content).toBe('Provider recovered after retrying.');
    }
  });

  it('shows a shorter retry update before the request settles', () => {
    const [start, next] = statusSequence('recovered');
    queue(start); queue(next);
    expect(buffer()).toHaveLength(1);
    expect(buffer()[0].content).toBe('Provider hit an error and is retrying (attempt 2).');
    expect(buffer()[0].metadata?.['streaming']).toBe(true);
  });

  it.each(terminalCases)('keeps the %s result arriving while an older status snapshot assembles', (phase, expected) => {
    const [start, next, end] = statusSequence(phase);
    const identity = { kind: 'history-replay', instanceId: 'status-fixture', createdAt: 1,
      adapterGeneration: 0, restartEpoch: 0, revision: 1 };
    const chunks = encodeJsonChunks({ ...identity, messages: [start] }, 'status-replay', { chunkSize: 128 })
      .map(chunk => ({ ...identity, chunk }));
    expect(chunks.length).toBeGreaterThan(1);
    store.acceptTranscriptChunk(chunks[0]);
    queue(next); queue(end);
    for (const chunk of chunks.slice(1)) store.acceptTranscriptChunk(chunk);
    expect(buffer().map(message => [message.content, message.metadata?.['phase'], message.metadata?.['streaming']]))
      .toEqual([[expected, phase, false]]);
  });

  it.each(['assistant', 'system'] as const)('keeps monotonic %s text when a different status source reuses its ID', type => {
    const original: OutputMessage = { id: 'retry-notice', type, timestamp: 1, content: 'Original complete committed content.',
      metadata: { streaming: true, source: type === 'system' ? 'other-status' : 'acp-retry-state' },
      thinking: [{ id: 'thought', content: 'Original complete reasoning.', format: 'structured' }] };
    queue(original);
    queue(buildRetryRecoveredMessage('retry-notice'));
    expect(buffer()[0].content).toBe('Original complete committed content.');
    expect(buffer()[0].thinking?.[0].content).toBe('Original complete reasoning.');
    expect(buffer()[0].type).toBe(type);
    expect(buffer()[0].metadata?.['source']).toBe(type === 'system' ? 'other-status' : 'acp-retry-state');
    expect(buffer()[0].metadata?.['streaming']).toBe(true);
  });

  it('keeps a shorter assistant final snapshot from rewinding text or thinking during history assembly', () => {
    const original: OutputMessage = { id: 'answer', type: 'assistant', timestamp: 1, content: 'Original complete answer.',
      metadata: { streaming: true }, thinking: [{ id: 'thought', content: 'Original complete reasoning.', format: 'structured' }] };
    const identity = { kind: 'history-replay', instanceId: 'status-fixture', createdAt: 1,
      adapterGeneration: 0, restartEpoch: 0, revision: 1 };
    const chunks = encodeJsonChunks({ ...identity, messages: [original] }, 'assistant-replay', { chunkSize: 128 })
      .map(chunk => ({ ...identity, chunk }));
    store.acceptTranscriptChunk(chunks[0]);
    queue({ ...original, content: 'Original', metadata: { streaming: false, accumulatedContent: 'Original' },
      thinking: undefined });
    for (const chunk of chunks.slice(1)) store.acceptTranscriptChunk(chunk);
    expect(buffer()[0].content).toBe('Original complete answer.');
    expect(buffer()[0].thinking?.[0].content).toBe('Original complete reasoning.');
    expect(buffer()[0].metadata?.['streaming']).toBe(false);
  });
});
