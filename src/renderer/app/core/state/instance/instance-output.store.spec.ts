import { NgZone } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from './instance.types';
import { InstanceStateService } from './instance-state.service';
import { InstanceOutputStore } from './instance-output.store';
import { ImageAttachmentService } from '../../../features/instance-detail/image-attachment.service';

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
    TestBed.resetTestingModule();
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
    outputBuffer: [],
    ...overrides,
  };
}
