import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc';
import { InstanceListStore } from './instance-list.store';
import { InstanceStateService } from './instance-state.service';

describe('InstanceListStore', () => {
  let store: InstanceListStore;
  let stateService: InstanceStateService;
  let ipc: {
    restartInstance: ReturnType<typeof vi.fn>;
    restartFreshInstance: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ipc = {
      restartInstance: vi.fn().mockResolvedValue({ success: true }),
      restartFreshInstance: vi.fn().mockResolvedValue({ success: true }),
    };

    TestBed.configureTestingModule({
      providers: [
        InstanceListStore,
        InstanceStateService,
        { provide: ElectronIpcService, useValue: ipc },
      ],
    });

    store = TestBed.inject(InstanceListStore);
    stateService = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('preserves the current model and infers gemini when provider is omitted', () => {
    const instance = store.deserializeInstance({
      id: 'instance-1',
      displayName: 'Hey Gemini',
      createdAt: 1,
      historyThreadId: 'thread-1',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 2,
      sessionId: 'legacy-session-1',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      currentModel: 'gemini-2.5-pro',
      outputBuffer: [],
    });

    expect(instance.provider).toBe('gemini');
    expect(instance.currentModel).toBe('gemini-2.5-pro');
  });

  it('infers gemini from restore identifiers when provider and model are missing', () => {
    const instance = store.deserializeInstance({
      id: 'instance-2',
      displayName: 'Recovered thread',
      createdAt: 1,
      historyThreadId: 'gemini-restore-123',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      lastActivity: 2,
      sessionId: 'gemini-session-456',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [],
    });

    expect(instance.provider).toBe('gemini');
  });

  it('preserves transcript and diff stats on resume restart', async () => {
    const instance = store.deserializeInstance({
      id: 'instance-3',
      displayName: 'Restart me',
      createdAt: 1,
      historyThreadId: 'thread-3',
      parentId: null,
      childrenIds: [],
      status: 'busy',
      contextUsage: {
        used: 12,
        total: 200000,
        percentage: 0.006,
      },
      lastActivity: 2,
      sessionId: 'session-3',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [
        {
          id: 'msg-1',
          timestamp: 3,
          type: 'assistant',
          content: 'done',
        },
      ],
      diffStats: {
        totalAdded: 5,
        totalDeleted: 1,
        files: {
          'src/main.ts': {
            path: 'src/main.ts',
            status: 'modified',
            added: 5,
            deleted: 1,
          },
        },
      },
    });

    stateService.addInstance({
      ...instance,
      hasUnreadCompletion: true,
    });

    await store.restartInstance(instance.id);

    expect(ipc.restartInstance).toHaveBeenCalledWith(instance.id);
    expect(stateService.getInstance(instance.id)).toMatchObject({
      status: 'busy',
      outputBuffer: instance.outputBuffer,
      diffStats: instance.diffStats,
      hasUnreadCompletion: true,
    });
  });

  it('delegates fresh restart without mutating renderer state optimistically', async () => {
    const instance = store.deserializeInstance({
      id: 'instance-4',
      displayName: 'Fresh restart me',
      createdAt: 1,
      historyThreadId: 'thread-4',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 2,
      sessionId: 'session-4',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [
        {
          id: 'msg-1',
          timestamp: 3,
          type: 'assistant',
          content: 'keep visible until backend archives it',
        },
      ],
    });

    stateService.addInstance(instance);

    await store.restartFreshInstance(instance.id);

    expect(ipc.restartFreshInstance).toHaveBeenCalledWith(instance.id);
    expect(stateService.getInstance(instance.id)?.outputBuffer).toEqual(
      instance.outputBuffer
    );
  });
});
