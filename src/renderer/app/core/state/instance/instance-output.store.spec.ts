import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from './instance.types';
import { LIMITS } from '../../../../../shared/constants/limits';
import { InstanceStateService } from './instance-state.service';
import { InstanceOutputStore } from './instance-output.store';
import { ImageAttachmentService } from '../../../features/instance-detail/image-attachment.service';
import { encodeJsonChunks } from '../../../../../shared/utils/json-chunks';
import { ToastService } from '../../services/toast.service';

describe('InstanceOutputStore', () => {
  let stateService: InstanceStateService;
  let store: InstanceOutputStore;
  let imageAttachmentService: { processMessage: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    imageAttachmentService = {
      processMessage: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        InstanceStateService,
        InstanceOutputStore,
        { provide: ImageAttachmentService, useValue: imageAttachmentService },
        { provide: NgZone, useValue: { run: (fn: () => void) => fn() } },
      ],
    });

    stateService = TestBed.inject(InstanceStateService);
    store = TestBed.inject(InstanceOutputStore);
    stateService.state.set({
      instances: new Map([
        ['inst-1', makeInstance({
          outputBuffer: [
            {
              id: 'msg-1',
              timestamp: 1,
              type: 'assistant',
              content: '![preview](/tmp/image.png)',
              metadata: { streaming: true },
            },
          ],
        })],
      ]),
      selectedInstanceId: null,
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    store.cleanupAll();
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  describe('authoritative native history replay', () => {
    const envelope = (messages: OutputMessage[], revision = 1) => {
      const identity = { kind: 'history-replay', instanceId: 'inst-1', createdAt: 0,
        adapterGeneration: 0, restartEpoch: 0, revision };
      return encodeJsonChunks({ ...identity, messages }, `replay-${revision}`, { chunkSize: 256 })
        .map(chunk => ({ ...identity, chunk }));
    };
    const accept = (chunk: unknown): void => {
      const apply = Reflect.get(store, 'acceptTranscriptChunk');
      expect(apply).toBeTypeOf('function');
      apply.call(store, chunk);
    };
    it('replaces stale and queued output while retaining a complete large attachment', () => {
      vi.useFakeTimers();
      store.queueOutput('inst-1', { id: 'old-queued', timestamp: 1, type: 'assistant', content: 'stale' });
      const attachment = { name: 'placeholder.txt', type: 'text/plain', size: 70000, data: 'a'.repeat(70000) };
      for (const chunk of envelope([{ id: 'native', timestamp: 2, type: 'user', content: 'restored', attachments: [attachment] }])) accept(chunk);
      vi.advanceTimersByTime(LIMITS.TEXT_THROTTLE_MS * 2);
      expect(stateService.getInstance('inst-1')?.outputBuffer).toEqual([
        { id: 'native', timestamp: 2, type: 'user', content: 'restored', attachments: [attachment] },
      ]);
      expect(imageAttachmentService.processMessage).not.toHaveBeenCalled();
    });
    it('keeps ordinary live buffer bounds after automatic replay without pinning unseen history', () => {
      const messages: OutputMessage[] = Array.from({ length: LIMITS.OUTPUT_BUFFER_MAX_SIZE }, (_, index) => ({
        id: `native-${index}`, type: 'assistant', timestamp: index, content: 'restored',
      }));
      const identity = { kind: 'history-replay', instanceId: 'inst-1', createdAt: 0,
        adapterGeneration: 0, restartEpoch: 0, revision: 1 };
      for (const chunk of encodeJsonChunks({ ...identity, messages }, 'bounded-replay')) accept({ ...identity, chunk });
      store.queueOutput('inst-1', { id: 'live', type: 'assistant', timestamp: 3000, content: 'new answer' });
      store.flushOutput('inst-1', false);
      expect(stateService.getInstance('inst-1')?.outputBuffer).toHaveLength(LIMITS.OUTPUT_BUFFER_MAX_SIZE);
      expect(stateService.getInstance('inst-1')?.outputBuffer.at(-1)?.id).toBe('live');
    });
    it('preserves live output received during chunk assembly without duplicating snapshot messages', () => {
      const chunks = envelope([{ id: 'native', timestamp: 2, type: 'assistant', content: 'restored '.repeat(100) }]);
      accept(chunks[0]);
      store.queueOutput('inst-1', { id: 'live', timestamp: 3, type: 'assistant', content: 'live response' });
      store.flushInstanceOutput('inst-1');
      for (const chunk of chunks.slice(1)) accept(chunk);
      expect(stateService.getInstance('inst-1')?.outputBuffer.map(message => message.id)).toEqual(['native', 'live']);
      for (const chunk of chunks) accept(chunk);
      expect(stateService.getInstance('inst-1')?.outputBuffer.map(message => message.id)).toEqual(['native', 'live']);
    });
    it('merges accumulated streaming text, thinking and retained attachments exactly like ordinary live output', () => {
      const snapshot: OutputMessage = { id: 'streamed', timestamp: 2, type: 'assistant', content: 'Original prefix',
        attachments: [{ name: 'placeholder.txt', type: 'text/plain', size: 1, data: 'x' }],
        thinking: [{ id: 'thought', content: 'Original reasoning', format: 'structured' }] };
      const chunks = envelope([snapshot]);
      accept(chunks[0]);
      store.queueOutput('inst-1', { id: 'streamed', timestamp: 3, type: 'assistant', content: ' extended',
        metadata: { streaming: true, accumulatedContent: 'Original prefix extended' },
        thinking: [{ id: 'thought', content: 'Original reasoning extended', format: 'structured' }] });
      store.flushInstanceOutput('inst-1');
      for (const chunk of chunks.slice(1)) accept(chunk);
      const message = stateService.getInstance('inst-1')?.outputBuffer[0];
      expect(message?.content).toBe('Original prefix extended');
      expect(message?.attachments).toEqual([{ name: 'placeholder.txt', type: 'text/plain', size: 1, data: 'x' }]);
      expect(message?.thinking).toEqual([{ id: 'thought', content: 'Original reasoning extended', format: 'structured' }]);
    });
    it('discards an old adapter transfer completed after replacement or removal', () => {
      const chunks = envelope([{ id: 'native', timestamp: 2, type: 'assistant', content: 'old '.repeat(100) }]);
      accept(chunks[0]);
      stateService.updateInstance('inst-1', { adapterGeneration: 1 });
      for (const chunk of chunks.slice(1)) accept(chunk);
      expect(stateService.getInstance('inst-1')?.outputBuffer[0].id).toBe('msg-1');
      store.cleanupInstance('inst-1');
      stateService.removeInstance('inst-1');
      for (const chunk of chunks) accept(chunk);
      expect(stateService.getInstance('inst-1')).toBeUndefined();
    });
    it('reports abandoned history visibly while continuing to retain new live output', () => {
      vi.useFakeTimers();
      const chunks = envelope([{ id: 'native', timestamp: 2, type: 'assistant', content: 'restored '.repeat(100) }]);
      accept(chunks[0]);
      vi.advanceTimersByTime(30001);
      expect(stateService.state().error).toContain('Unable to restore the full conversation history');
      expect(TestBed.inject(ToastService).toasts()).toEqual([
        expect.objectContaining({ type: 'error', text: expect.stringContaining('Unable to restore the full conversation history') }),
      ]);
      store.queueOutput('inst-1', { id: 'live-after-timeout', timestamp: 3, type: 'assistant', content: 'keep working' });
      store.flushInstanceOutput('inst-1');
      for (const chunk of chunks.slice(1)) accept(chunk);
      expect(stateService.getInstance('inst-1')?.outputBuffer.map(message => message.id)).toEqual(['msg-1', 'live-after-timeout']);
    });
  });

  describe('user message publication', () => {
    const seed: OutputMessage = {
      id: 'initial-user', timestamp: 2, type: 'user', content: 'Use the Windows worker',
      attachments: [{ name: 'request.txt', type: 'text/plain', size: 7, data: 'request' }],
      failedImages: [{ src: '/tmp/missing.png', kind: 'local', reason: 'not_found', message: 'Missing' }],
    };
    const userMessages = (): OutputMessage[] =>
      stateService.getInstance('inst-1')!.outputBuffer.filter((message) => message.type === 'user');

    it('keeps one seeded user record when its canonical event flushes after the throttle delay', () => {
      vi.useFakeTimers();
      stateService.updateInstance('inst-1', { outputBuffer: [seed] });

      store.queueOutput('inst-1', {
        id: 'initial-user', timestamp: 2, type: 'user', content: 'Use the Windows worker',
        metadata: { adapterGeneration: 0 },
      });
      vi.advanceTimersByTime(LIMITS.TEXT_THROTTLE_MS);

      expect(userMessages()).toHaveLength(1);
      expect(userMessages()[0].attachments).toEqual([
        { name: 'request.txt', type: 'text/plain', size: 7, data: 'request' },
      ]);
      expect(userMessages()[0].failedImages).toEqual([
        { src: '/tmp/missing.png', kind: 'local', reason: 'not_found', message: 'Missing' },
      ]);
    });

    it('keeps one user record when the same ID is repeated within and across batches', () => {
      store.queueOutput('inst-1', seed);
      store.queueOutput('inst-1', { ...seed });
      store.flushInstanceOutput('inst-1');
      store.queueOutput('inst-1', { ...seed });
      store.flushInstanceOutput('inst-1');

      expect(userMessages().map((message) => message.id)).toEqual(['initial-user']);
    });

    it('deduplicates against a snapshot installed while the user event is pending', () => {
      store.queueOutput('inst-1', seed);
      stateService.updateInstance('inst-1', { outputBuffer: [seed] });
      store.flushInstanceOutput('inst-1');

      expect(userMessages().map((message) => message.id)).toEqual(['initial-user']);
    });

    it('preserves new user messages with distinct IDs even when their content matches', () => {
      stateService.updateInstance('inst-1', { outputBuffer: [seed] });
      store.queueOutput('inst-1', { ...seed, id: 'follow-up', timestamp: 3 });
      store.queueOutput('inst-1', { id: 'new-user', timestamp: 4, type: 'user', content: 'Next request' });
      store.flushInstanceOutput('inst-1');

      expect(userMessages().map((message) => [message.id, message.content])).toEqual([
        ['initial-user', 'Use the Windows worker'],
        ['follow-up', 'Use the Windows worker'],
        ['new-user', 'Next request'],
      ]);
    });

    it('preserves non-streaming assistant parts and error messages alongside user publication', () => {
      store.queueOutput('inst-1', seed);
      store.queueOutput('inst-1', { id: 'part', timestamp: 3, type: 'assistant', content: 'First part' });
      store.queueOutput('inst-1', { id: 'part', timestamp: 4, type: 'assistant', content: 'Second part' });
      store.queueOutput('inst-1', { id: 'initial-user', timestamp: 5, type: 'error', content: 'Send failed' });
      store.flushInstanceOutput('inst-1');

      expect(stateService.getInstance('inst-1')!.outputBuffer.slice(1).map((message) => message.content)).toEqual([
        'Use the Windows worker', 'First part', 'Second part', 'Send failed',
      ]);
    });
  });

  it('finalizes unresolved streaming assistant messages when the instance flushes on completion', () => {
    store.flushInstanceOutput('inst-1');

    expect(imageAttachmentService.processMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ id: 'msg-1' }),
      store,
      { finalized: true },
    );
  });

  it('does not let an empty streaming update wipe already-committed assistant text', () => {
    // Seed a streaming assistant bubble with real content.
    store.queueOutput('inst-1', {
      id: 'stream-1',
      timestamp: 2,
      type: 'assistant',
      content: 'first segment of the deliverable',
      metadata: { streaming: true },
    });
    store.flushInstanceOutput('inst-1');

    // A later streaming update for the SAME id arrives with empty content but
    // carries a thinking block (so it clears the empty-message gate and reaches
    // the streaming-replace path). It must not erase the visible text; thinking
    // still updates.
    store.queueOutput('inst-1', {
      id: 'stream-1',
      timestamp: 3,
      type: 'assistant',
      content: '',
      metadata: { streaming: true, accumulatedContent: '' },
      thinking: [{ id: 't1', content: 'reasoning', format: 'structured', timestamp: 3 }],
    });
    store.flushInstanceOutput('inst-1');

    const buffer = stateService.getInstance('inst-1')?.outputBuffer ?? [];
    const bubble = buffer.find((m) => m.id === 'stream-1');
    expect(bubble?.content).toBe('first segment of the deliverable');
    expect(bubble?.thinking?.[0]?.content).toBe('reasoning');
  });

  it('does not let a shorter streaming snapshot rewind already-committed assistant text', () => {
    store.queueOutput('inst-1', {
      id: 'stream-rewind',
      timestamp: 2,
      type: 'assistant',
      content: "I'll check those attached todo files and whether a single de-duplicated merge already exists.",
      metadata: {
        streaming: true,
        accumulatedContent:
          "I'll check those attached todo files and whether a single de-duplicated merge already exists.",
      },
    });
    store.flushInstanceOutput('inst-1');

    store.queueOutput('inst-1', {
      id: 'stream-rewind',
      timestamp: 3,
      type: 'assistant',
      content: "I'll",
      metadata: { streaming: true, accumulatedContent: "I'll" },
    });
    store.flushInstanceOutput('inst-1');

    const buffer = stateService.getInstance('inst-1')?.outputBuffer ?? [];
    expect(buffer.find((m) => m.id === 'stream-rewind')?.content).toBe(
      "I'll check those attached todo files and whether a single de-duplicated merge already exists.",
    );
  });

  it('renders accumulated streaming content in distinct bubbles across turns', () => {
    store.queueOutput('inst-1', {
      id: 'turn-1',
      timestamp: 2,
      type: 'assistant',
      content: 'hi ',
      metadata: { streaming: true, accumulatedContent: 'hi ' },
    });
    store.queueOutput('inst-1', {
      id: 'turn-1',
      timestamp: 3,
      type: 'assistant',
      content: 'there',
      metadata: { streaming: true, accumulatedContent: 'hi there' },
    });
    store.flushInstanceOutput('inst-1');

    store.queueOutput('inst-1', {
      id: 'turn-2',
      timestamp: 4,
      type: 'assistant',
      content: 'ALPHA-',
      metadata: { streaming: true, accumulatedContent: 'ALPHA-' },
    });
    store.queueOutput('inst-1', {
      id: 'turn-2',
      timestamp: 5,
      type: 'assistant',
      content: '742',
      metadata: { streaming: true, accumulatedContent: 'ALPHA-742' },
    });
    store.flushInstanceOutput('inst-1');

    const buffer = stateService.getInstance('inst-1')?.outputBuffer ?? [];
    expect(buffer.filter((message) => message.id === 'turn-1')).toHaveLength(1);
    expect(buffer.filter((message) => message.id === 'turn-2')).toHaveLength(1);
    expect(buffer.find((message) => message.id === 'turn-1')?.content).toBe('hi there');
    expect(buffer.find((message) => message.id === 'turn-2')?.content).toBe('ALPHA-742');
  });

  it('appends attachments and failure cards without duplicating them', () => {
    store.appendAttachmentsToMessage(
      'inst-1',
      'msg-1',
      [
        {
          name: 'preview.png',
          type: 'image/png',
          size: 10,
          data: 'data:image/png;base64,aaa',
        },
        {
          name: 'preview.png',
          type: 'image/png',
          size: 10,
          data: 'data:image/png;base64,aaa',
        },
      ],
      [
        {
          src: '/tmp/image.png',
          kind: 'local',
          reason: 'not_found',
          message: 'Missing',
        },
        {
          src: '/tmp/image.png',
          kind: 'local',
          reason: 'not_found',
          message: 'Missing',
        },
      ],
    );

    const message = stateService.getInstance('inst-1')?.outputBuffer[0];
    expect(message?.attachments).toHaveLength(1);
    expect(message?.failedImages).toHaveLength(1);
  });

  it('marks image extraction as complete on the message metadata', () => {
    store.markImagesResolved('inst-1', 'msg-1');

    expect(
      stateService.getInstance('inst-1')?.outputBuffer[0].metadata?.['imagesResolved']
    ).toBe(true);
  });

  describe('loaded history and the buffer cap', () => {
    const max = LIMITS.OUTPUT_BUFFER_MAX_SIZE;
    const live = (count: number, prefix = 'live'): OutputMessage[] =>
      Array.from({ length: count }, (_, i) => ({
        id: `${prefix}-${i}`,
        timestamp: 1_000 + i,
        type: 'assistant' as const,
        content: `${prefix} ${i}`,
      }));
    const buffer = (): OutputMessage[] => stateService.state().instances.get('inst-1')!.outputBuffer;

    beforeEach(() => {
      stateService.updateInstance('inst-1', { outputBuffer: live(max) });
    });

    it('keeps history the user loaded when new output would push the buffer past its cap', () => {
      store.prependOlderMessages('inst-1', live(3, 'older'));
      store.queueOutput('inst-1', { id: 'new-1', timestamp: 9_999, type: 'assistant', content: 'next' });
      store.flushInstanceOutput('inst-1');

      expect(buffer()[0].id).toBe('older-0');
      expect(buffer()).toHaveLength(max + 4);
    });

    it('still trims to the cap when no history was loaded', () => {
      store.queueOutput('inst-1', { id: 'new-1', timestamp: 9_999, type: 'assistant', content: 'next' });
      store.flushInstanceOutput('inst-1');

      expect(buffer()).toHaveLength(max);
      expect(buffer()[0].id).toBe('live-1');
    });

    it('releases loaded history by trimming back to the cap and reporting what it dropped', () => {
      store.prependOlderMessages('inst-1', live(3, 'older'));

      expect(store.releaseLoadedHistory('inst-1')).toBe(3);
      expect(buffer()).toHaveLength(max);
      expect(buffer()[0].id).toBe('live-0');

      // Released: the cap applies to later output again.
      store.queueOutput('inst-1', { id: 'new-1', timestamp: 9_999, type: 'assistant', content: 'next' });
      store.flushInstanceOutput('inst-1');
      expect(buffer()).toHaveLength(max);
    });

    it('keeps the pin while the buffer is still within the cap', () => {
      stateService.updateInstance('inst-1', { outputBuffer: live(10) });
      store.prependOlderMessages('inst-1', live(3, 'older'));

      expect(store.releaseLoadedHistory('inst-1')).toBe(0);
      store.queueOutput('inst-1', { id: 'new-1', timestamp: 9_999, type: 'assistant', content: 'next' });
      store.flushInstanceOutput('inst-1');
      expect(buffer()[0].id).toBe('older-0');
    });

    it('does nothing for an instance with no loaded history', () => {
      expect(store.releaseLoadedHistory('inst-1')).toBe(0);
      expect(buffer()).toHaveLength(max);
    });
  });
});

function makeInstance(overrides: Partial<Instance>): Instance {
  return {
    id: 'inst-1',
    displayName: 'Instance 1',
    createdAt: 0,
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status: 'idle',
    contextUsage: { used: 0, total: 1000, percentage: 0 },
    lastActivity: 0,
    providerSessionId: 'provider-session',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp',
    yoloMode: false,
    launchMode: 'interactive',
    outputBuffer: [],
    ...overrides,
  };
}
