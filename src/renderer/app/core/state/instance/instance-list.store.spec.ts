import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc';
import { InstanceListStore } from './instance-list.store';
import { InstanceStateService } from './instance-state.service';

describe('InstanceListStore', () => {
  let store: InstanceListStore;
  let stateService: InstanceStateService;
  let ipc: {
    createInstance: ReturnType<typeof vi.fn>;
    listInstances: ReturnType<typeof vi.fn>;
    stateResync: ReturnType<typeof vi.fn>;
    restartInstance: ReturnType<typeof vi.fn>;
    restartFreshInstance: ReturnType<typeof vi.fn>;
    changeModel: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    ipc = {
      createInstance: vi.fn().mockResolvedValue({
        success: true,
        data: {
          id: 'created-instance',
          displayName: 'Created instance',
          createdAt: 1,
          historyThreadId: 'thread-created',
          parentId: null,
          childrenIds: [],
          status: 'idle',
          lastActivity: 2,
          sessionId: 'session-created',
          workingDirectory: '/tmp/project',
          yoloMode: false,
          launchMode: 'orchestrated',
          provider: 'claude',
          outputBuffer: [],
        },
      }),
      listInstances: vi.fn().mockResolvedValue({ success: true, data: [] }),
      stateResync: vi.fn().mockResolvedValue({
        success: true,
        data: {
          instances: [],
          loopRuns: [],
          automationRuns: [],
          pauseState: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
          memoryPressure: 'normal',
          seq: 0,
        },
      }),
      restartInstance: vi.fn().mockResolvedValue({ success: true }),
      restartFreshInstance: vi.fn().mockResolvedValue({ success: true }),
      changeModel: vi.fn().mockResolvedValue({ success: true }),
    };

    TestBed.resetTestingModule();
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

  it('preserves activityState when deserializing instance payloads', () => {
    const instance = store.deserializeInstance({
      id: 'instance-activity',
      displayName: 'Observed thread',
      createdAt: 1,
      historyThreadId: 'thread-activity',
      parentId: null,
      childrenIds: [],
      status: 'processing',
      activityState: 'blocked',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 2,
      sessionId: 'session-activity',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [],
    });

    expect(instance.activityState).toBe('blocked');
  });

  it('never auto-selects instances arriving via passive instance:created events', () => {
    // Even with nothing selected, a backend-created session (e.g. a child
    // spawned on a remote node) must not steal focus.
    store.addInstance({
      id: 'background-instance',
      displayName: 'Background-created thread',
      createdAt: 1,
      historyThreadId: 'thread-background',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      lastActivity: 2,
      sessionId: 'session-background',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [],
    });

    expect(stateService.getInstance('background-instance')).toBeDefined();
    expect(stateService.state().selectedInstanceId).toBeNull();
  });

  it('does not change an existing selection when a passive instance event arrives', () => {
    stateService.addInstance(
      store.deserializeInstance({
        id: 'current-instance',
        displayName: 'Current thread',
        createdAt: 1,
        historyThreadId: 'thread-current',
        parentId: null,
        childrenIds: [],
        status: 'idle',
        lastActivity: 2,
        sessionId: 'session-current',
        workingDirectory: '/tmp/project',
        yoloMode: false,
        outputBuffer: [],
      }),
    );
    stateService.setSelectedInstance('current-instance');

    store.addInstance({
      id: 'remote-child-instance',
      displayName: 'Remote child',
      createdAt: 3,
      historyThreadId: 'thread-remote-child',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      lastActivity: 4,
      sessionId: 'session-remote-child',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [],
    });

    expect(stateService.getInstance('remote-child-instance')).toBeDefined();
    expect(stateService.state().selectedInstanceId).toBe('current-instance');
  });

  it('loads initial instances from the state:resync snapshot instead of the legacy instance list', async () => {
    ipc.stateResync.mockResolvedValue({
      success: true,
      data: {
        instances: [
          {
            id: 'snapshot-instance',
            displayName: 'Snapshot instance',
            createdAt: 1,
            historyThreadId: 'thread-snapshot',
            parentId: null,
            childrenIds: [],
            status: 'idle',
            lastActivity: 2,
            sessionId: 'session-snapshot',
            workingDirectory: '/tmp/project',
            yoloMode: false,
            provider: 'claude',
            outputBuffer: [],
          },
        ],
        loopRuns: [],
        automationRuns: [],
        pauseState: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
        memoryPressure: 'normal',
        seq: 5,
      },
    });

    await store.loadInitialInstances();

    expect(ipc.stateResync).toHaveBeenCalledOnce();
    expect(ipc.listInstances).not.toHaveBeenCalled();
    expect(stateService.getInstance('snapshot-instance')).toMatchObject({
      id: 'snapshot-instance',
      displayName: 'Snapshot instance',
    });
    expect(stateService.state().loading).toBe(false);
  });

  it('returns the created instance id when creating a blank instance', async () => {
    const id = await store.createInstanceAndReturnId({
      workingDirectory: '/tmp/project',
      agentId: 'build',
      provider: 'claude',
      model: 'opus',
      launchMode: 'interactive',
    });

    expect(id).toBe('created-instance');
    expect(ipc.createInstance).toHaveBeenCalledWith({
      workingDirectory: '/tmp/project',
      displayName: undefined,
      parentInstanceId: undefined,
      yoloMode: undefined,
      agentId: 'build',
      provider: 'claude',
      model: 'opus',
      launchMode: 'interactive',
      forceNodeId: undefined,
    });
    expect(stateService.getInstance('created-instance')).toBeDefined();
    expect(stateService.state().selectedInstanceId).toBe('created-instance');
  });

  it('returns the created instance id from state when the create invoke does not resolve', async () => {
    ipc.createInstance.mockReturnValue(new Promise(() => undefined));

    const pending = store.createInstanceAndReturnId({
      workingDirectory: '/tmp/project',
      agentId: 'build',
      provider: 'claude',
    });

    stateService.addInstance(
      store.deserializeInstance({
        id: 'event-created-instance',
        displayName: 'Event-created instance',
        createdAt: 1,
        historyThreadId: 'thread-event-created',
        parentId: null,
        childrenIds: [],
        status: 'idle',
        lastActivity: 2,
        sessionId: 'session-event-created',
        workingDirectory: '/tmp/project',
        yoloMode: false,
        provider: 'claude',
        outputBuffer: [],
      }),
    );

    const id = await pending;

    expect(id).toBe('event-created-instance');
    expect(stateService.state().loading).toBe(false);
    expect(stateService.state().selectedInstanceId).toBe('event-created-instance');
  });

  it('defaults legacy deserialized instances to orchestrated launch mode', () => {
    const instance = store.deserializeInstance({
      id: 'legacy-launch-mode',
      displayName: 'Legacy instance',
      createdAt: 1,
      historyThreadId: 'thread-legacy-launch',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      lastActivity: 2,
      sessionId: 'session-legacy-launch',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      outputBuffer: [],
    });

    expect(instance.launchMode).toBe('orchestrated');
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

  it('does not request a model change while an instance is not waiting for user input', async () => {
    const instance = store.deserializeInstance({
      id: 'instance-model-blocked',
      displayName: 'Blocked model switch',
      createdAt: 1,
      historyThreadId: 'thread-model-blocked',
      parentId: null,
      childrenIds: [],
      status: 'processing',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 2,
      sessionId: 'session-model-blocked',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      currentModel: 'sonnet',
      outputBuffer: [],
    });
    stateService.addInstance(instance);

    await store.changeModel(instance.id, 'sonnet[1m]');

    expect(ipc.changeModel).not.toHaveBeenCalled();
    expect(stateService.getInstance(instance.id)?.currentModel).toBe('sonnet');
    expect(stateService.state().error).toContain('waiting for user input');
  });

  it('passes reasoning effort through model changes and stores the returned value', async () => {
    ipc.changeModel.mockResolvedValue({
      success: true,
      data: {
        currentModel: 'sonnet[1m]',
        reasoningEffort: 'high',
        status: 'idle',
      },
    });
    const instance = store.deserializeInstance({
      id: 'instance-model-thinking',
      displayName: 'Thinking model switch',
      createdAt: 1,
      historyThreadId: 'thread-model-thinking',
      parentId: null,
      childrenIds: [],
      status: 'idle',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 2,
      sessionId: 'session-model-thinking',
      workingDirectory: '/tmp/project',
      yoloMode: false,
      currentModel: 'sonnet',
      outputBuffer: [],
    });
    stateService.addInstance(instance);

    await (store as InstanceListStore & {
      changeModel: (instanceId: string, newModel: string, reasoningEffort?: 'high') => Promise<void>;
    }).changeModel(instance.id, 'sonnet[1m]', 'high');

    expect(ipc.changeModel).toHaveBeenCalledWith(instance.id, 'sonnet[1m]', 'high');
    expect(stateService.getInstance(instance.id)).toMatchObject({
      currentModel: 'sonnet[1m]',
      reasoningEffort: 'high',
      status: 'idle',
    });
  });
});
