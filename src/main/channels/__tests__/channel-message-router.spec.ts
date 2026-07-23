import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import { EventEmitter } from 'events';
import { ChannelMessageRouter } from '../channel-message-router';
import type { ChannelManager, ChannelEvent } from '../channel-manager';
import type { ChannelPersistence } from '../channel-persistence';
import type { ChannelRouteStore, SavedChannelRoutePin } from '../channel-route-store';
import type { AccessPolicy, InboundChannelMessage, SendOptions, SentMessage } from '../../../shared/types/channels';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock remote-node barrel to prevent transitive import chain reaching
// command-manager.ts → ElectronStore (which requires Electron runtime)
vi.mock('../../remote-node', () => ({
  getWorkerNodeRegistry: () => ({
    getAllNodes: vi.fn(() => []),
    selectNodeForPlacement: vi.fn(() => null),
  }),
}));

const {
  remoteNodeConfigState,
  updateRemoteNodeConfigMock,
  settingsSetMock,
  settingsState,
  settingsGetMock,
  recentDirectoriesState,
  addRecentDirectoryMock,
  hibernatedInstancesState,
  historyEntriesState,
} = vi.hoisted(() => {
  const remoteNodeConfigState = {
    enabled: false,
    autoOffloadBrowser: false,
    autoOffloadGpu: false,
    maxRemoteInstances: 20,
  };
  const updateRemoteNodeConfigMock = vi.fn((partial: Partial<typeof remoteNodeConfigState>) => {
    Object.assign(remoteNodeConfigState, partial);
  });
  const settingsSetMock = vi.fn();
  const settingsState = {
    notifyOnAgentCompletion: true,
    channelToolHeartbeat: false,
  };
  const settingsGetMock = vi.fn((key: string) => (settingsState as Record<string, unknown>)[key]);
  const recentDirectoriesState = {
    entries: [] as {
      path: string;
      displayName?: string;
      lastAccessed?: number;
    }[],
  };
  const addRecentDirectoryMock = vi.fn();
  const hibernatedInstancesState = {
    entries: [] as {
      instanceId: string;
      displayName: string;
      agentId: string;
      sessionState: Record<string, unknown>;
      hibernatedAt: number;
      workingDirectory?: string;
    }[],
  };
  const historyEntriesState = {
    entries: [] as {
      id: string;
      workingDirectory?: string;
      firstUserMessage?: string;
      displayName?: string;
      createdAt?: number;
      endedAt?: number;
    }[],
  };

  return {
    remoteNodeConfigState,
    updateRemoteNodeConfigMock,
    settingsSetMock,
    settingsState,
    settingsGetMock,
    recentDirectoriesState,
    addRecentDirectoryMock,
    hibernatedInstancesState,
    historyEntriesState,
  };
});

vi.mock('../../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => ({ ...remoteNodeConfigState }),
  updateRemoteNodeConfig: updateRemoteNodeConfigMock,
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    set: settingsSetMock,
    get: settingsGetMock,
  }),
}));

vi.mock('../../core/config/recent-directories-manager', () => ({
  getRecentDirectoriesManager: () => ({
    getDirectories: vi.fn(async () => recentDirectoriesState.entries),
    addDirectory: addRecentDirectoryMock,
  }),
}));

vi.mock('../../process/hibernation-manager', () => ({
  getHibernationManager: () => ({
    getHibernatedInstances: vi.fn(() => hibernatedInstancesState.entries),
  }),
}));

vi.mock('../../history/history-manager', () => ({
  getHistoryManager: () => ({
    getEntries: vi.fn(() => historyEntriesState.entries),
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: 'msg-1',
    platform: 'discord',
    chatId: 'chat-1',
    messageId: 'discord-msg-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'Hello agent',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: 1000,
    ...overrides,
  };
}

function makeOutputEnvelope(
  instanceId: string,
  content: string,
): ProviderRuntimeEventEnvelope {
  return {
    eventId: `${instanceId}-${content || 'empty'}-event`,
    seq: 0,
    timestamp: 1000,
    provider: 'claude',
    instanceId,
    event: {
      kind: 'output',
      content,
      messageType: 'assistant',
    },
  };
}

function makeSentMessage(overrides: Partial<SentMessage> = {}): SentMessage {
  return { messageId: 'sent-1', chatId: 'chat-1', timestamp: Date.now(), ...overrides };
}

function makeEnvelope(
  instanceId: string,
  event: {
    content?: string;
    messageType?: string;
    messageId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachments?: any[];
    metadata?: Record<string, unknown>;
  },
): ProviderRuntimeEventEnvelope {
  return {
    eventId: `${instanceId}-${event.messageId ?? event.messageType ?? 'evt'}`,
    seq: 0,
    timestamp: 1000,
    provider: 'claude',
    instanceId,
    event: {
      kind: 'output',
      content: event.content ?? '',
      messageType: event.messageType ?? 'assistant',
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.attachments ? { attachments: event.attachments } : {}),
      ...(event.metadata ? { metadata: event.metadata } : {}),
    },
  } as ProviderRuntimeEventEnvelope;
}

function dataUrl(text: string): string {
  return `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
}

interface MockInstanceRecord {
  id: string;
  status: string;
  displayName?: string;
  workingDirectory?: string;
  lastActivity?: number;
  outputBuffer?: { id?: string; type: string; content: string }[];
}

function makeMockAdapter() {
  let accessPolicy: AccessPolicy = {
    mode: 'pairing',
    allowedSenders: ['user-1'],
    pendingPairings: [],
    maxPending: 3,
    codeExpiryMs: 60 * 60 * 1000,
  };
  return {
    status: 'connected',
    sendMessage: vi.fn<(chatId: string, content: string, options?: SendOptions) => Promise<SentMessage>>(
      async () => makeSentMessage(),
    ),
    addReaction: vi.fn(async () => undefined),
    sendFile: vi.fn<(chatId: string, filePath: string, caption?: string) => Promise<SentMessage>>(
      async () => makeSentMessage(),
    ),
    editMessage: vi.fn(async () => undefined),
    getAccessPolicy: vi.fn(() => accessPolicy),
    setAccessPolicy: vi.fn((nextPolicy: AccessPolicy) => {
      accessPolicy = nextPolicy;
    }),
    getDisplayName: vi.fn((): string | undefined => undefined),
  };
}

function makeMockPersistence() {
  return {
    saveMessage: vi.fn(),
    resolveInstanceByThread: vi.fn(() => null as string | null),
    updateInstanceId: vi.fn(),
  };
}

function makeMockOrchestration() {
  const em = new EventEmitter();
  return Object.assign(em, {
    respondToUserAction: vi.fn<(requestId: string, approved: boolean, selectedOption?: string) => void>(),
  });
}

function makeMockInstanceManager() {
  const em = new EventEmitter();
  const getInstances = vi.fn(() => [] as MockInstanceRecord[]);
  const orchestration = makeMockOrchestration();
  return Object.assign(em, {
    createInstance: vi.fn(async () => ({ id: 'inst-1' })),
    sendInput: vi.fn(async () => undefined),
    getInstances,
    getInstance: vi.fn((instanceId: string) => {
      return getInstances().find((instance) => instance.id === instanceId) ?? null;
    }),
    wakeInstance: vi.fn(async (instanceId: string) => {
      const instance = getInstances().find((entry) => entry.id === instanceId);
      if (instance) {
        instance.status = 'ready';
      }
    }),
    interruptInstance: vi.fn(() => true),
    // Prompt-bridge (backlog #1) seams — mirror the real InstanceManager surface.
    resumeAfterDeferredPermission: vi.fn(async () => undefined),
    clearPendingInputRequiredPermission: vi.fn(),
    getOrchestrationHandler: vi.fn(() => orchestration),
  });
}

function makeMockRouteStore() {
  const pins = new Map<string, SavedChannelRoutePin>();
  const keyFor = (platform: string, scope: string, routeKey: string) => `${platform}:${scope}:${routeKey}`;
  return {
    savePin: vi.fn((platform: string, scope: string, routeKey: string, pin: SavedChannelRoutePin) => {
      pins.set(keyFor(platform, scope, routeKey), pin);
    }),
    getPin: vi.fn((platform: string, scope: string, routeKey: string) => {
      return pins.get(keyFor(platform, scope, routeKey)) ?? null;
    }),
    removePin: vi.fn((platform: string, scope: string, routeKey: string) => {
      pins.delete(keyFor(platform, scope, routeKey));
    }),
    removePlatform: vi.fn((platform: string) => {
      for (const key of pins.keys()) {
        if (key.startsWith(`${platform}:`)) {
          pins.delete(key);
        }
      }
    }),
  };
}

function makeMockChannelManager(adapter: ReturnType<typeof makeMockAdapter>) {
  const listeners = new Set<(event: ChannelEvent) => void>();
  return {
    getAdapter: vi.fn(() => adapter),
    onEvent: vi.fn((cb: (event: ChannelEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    emitResponseSent: vi.fn(),
    // helper for tests to emit events
    _emit: (event: ChannelEvent) => {
      for (const l of listeners) l(event);
    },
  } as unknown as ChannelManager & {
    emitResponseSent: ReturnType<typeof vi.fn>;
    _emit: (event: ChannelEvent) => void;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelMessageRouter', () => {
  let adapter: ReturnType<typeof makeMockAdapter>;
  let persistence: ReturnType<typeof makeMockPersistence>;
  let channelManager: ReturnType<typeof makeMockChannelManager>;
  let instanceManager: ReturnType<typeof makeMockInstanceManager>;
  let routeStore: ReturnType<typeof makeMockRouteStore>;
  let router: ChannelMessageRouter;

  beforeEach(() => {
    remoteNodeConfigState.enabled = false;
    remoteNodeConfigState.autoOffloadBrowser = false;
    remoteNodeConfigState.autoOffloadGpu = false;
    remoteNodeConfigState.maxRemoteInstances = 20;
    updateRemoteNodeConfigMock.mockClear();
    settingsSetMock.mockClear();
    settingsGetMock.mockClear();
    settingsState.notifyOnAgentCompletion = true;
    settingsState.channelToolHeartbeat = false;
    recentDirectoriesState.entries = [];
    addRecentDirectoryMock.mockClear();
    hibernatedInstancesState.entries = [];
    historyEntriesState.entries = [];
    adapter = makeMockAdapter();
    persistence = makeMockPersistence();
    channelManager = makeMockChannelManager(adapter);
    instanceManager = makeMockInstanceManager();
    routeStore = makeMockRouteStore();
    router = new ChannelMessageRouter(
      channelManager as unknown as ChannelManager,
      persistence as unknown as ChannelPersistence,
      routeStore as unknown as ChannelRouteStore,
    );
    router._setInstanceManagerForTesting(instanceManager);
  });

  afterEach(() => {
    router.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  describe('start / stop', () => {
    it('subscribes to channel manager events on start', () => {
      router.start();
      expect(channelManager.onEvent).toHaveBeenCalledOnce();
    });

    it('unsubscribes on stop', () => {
      router.start();
      router.stop();
      // After unsubscribing, emitting a message should not reach the router
      const createSpy = instanceManager.createInstance;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (channelManager as any)._emit({ type: 'message', data: makeMessage() });
      // Give any microtasks a chance (no await needed since stop cleared)
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('blocks sender after exceeding 10 messages per minute', async () => {
      // Send 10 messages (all pass)
      for (let i = 0; i < 10; i++) {
        await router.handleInboundMessage(makeMessage({ id: `msg-${i}`, messageId: `m${i}` }));
      }
      // Reset mocks to detect the 11th call specifically
      adapter.addReaction.mockClear();
      instanceManager.createInstance.mockClear();

      // 11th message should be rate-limited
      await router.handleInboundMessage(makeMessage({ id: 'msg-11', messageId: 'm11' }));

      // Should add the clock reaction and NOT create an instance
      expect(adapter.addReaction).toHaveBeenCalledWith('chat-1', 'm11', '⏳');
      expect(instanceManager.createInstance).not.toHaveBeenCalled();
    });

    it('tracks rate limits per sender independently', async () => {
      // Exhaust user-1
      for (let i = 0; i < 10; i++) {
        await router.handleInboundMessage(makeMessage({ id: `msg-${i}`, messageId: `m${i}`, senderId: 'user-1' }));
      }
      instanceManager.createInstance.mockClear();

      // user-2 should still pass
      await router.handleInboundMessage(makeMessage({ id: 'msg-u2', messageId: 'm-u2', senderId: 'user-2' }));
      expect(instanceManager.createInstance).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // parseIntent
  // -------------------------------------------------------------------------

  describe('parseIntent', () => {
    it('returns default intent for plain content', () => {
      const intent = router.parseIntent('hello world');
      expect(intent.type).toBe('default');
      expect(intent.cleanContent).toBe('hello world');
    });

    it('parses @instance-<id> as explicit intent', () => {
      const intent = router.parseIntent('@instance-3 do the thing');
      expect(intent.type).toBe('explicit');
      expect(intent.instanceId).toBe('3');
      expect(intent.cleanContent).toBe('do the thing');
    });

    it('parses @all as broadcast intent', () => {
      const intent = router.parseIntent('@all stop all work');
      expect(intent.type).toBe('broadcast');
      expect(intent.cleanContent).toBe('stop all work');
    });

    it('returns thread intent when persistence resolves threadId', () => {
      persistence.resolveInstanceByThread.mockReturnValue('inst-42');
      const intent = router.parseIntent('follow up question', 'thread-99');
      expect(intent.type).toBe('thread');
      expect(intent.instanceId).toBe('inst-42');
      expect(intent.cleanContent).toBe('follow up question');
    });

    it('returns default intent when threadId resolves to null', () => {
      persistence.resolveInstanceByThread.mockReturnValue(null);
      const intent = router.parseIntent('new question', 'thread-99');
      expect(intent.type).toBe('default');
    });

    it('@instance pattern takes precedence over threadId', () => {
      persistence.resolveInstanceByThread.mockReturnValue('thread-inst');
      const intent = router.parseIntent('@instance-5 hello', 'thread-99');
      expect(intent.type).toBe('explicit');
      expect(intent.instanceId).toBe('5');
    });
  });

  // -------------------------------------------------------------------------
  // Default routing (creates new instance)
  // -------------------------------------------------------------------------

  describe('default routing', () => {
    it('creates a new instance with message content', async () => {
      await router.handleInboundMessage(makeMessage({ content: 'run this task' }));

      expect(instanceManager.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPrompt: expect.stringContaining('<channel_message>\nrun this task\n</channel_message>'),
          yoloMode: true,
        })
      );
    });

    it('updates instance_id in persistence after routing', async () => {
      await router.handleInboundMessage(makeMessage({ id: 'msg-abc' }));
      expect(persistence.updateInstanceId).toHaveBeenCalledWith('msg-abc', 'inst-1');
    });

    it('saves the inbound message to persistence', async () => {
      const msg = makeMessage({ id: 'save-test', content: 'save me' });
      await router.handleInboundMessage(msg);
      expect(persistence.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'save-test',
          direction: 'inbound',
          content: 'save me',
        })
      );
    });

    it('adds eyes reaction on receipt and check reaction only when the turn completes', async () => {
      vi.useFakeTimers();
      instanceManager.getInstances.mockReturnValue([{ id: 'inst-1', status: 'busy', outputBuffer: [] }]);
      const msg = makeMessage({ chatId: 'c1', messageId: 'dm1' });
      await router.handleInboundMessage(msg);

      // 👀 on receipt, but no ✅ yet — the turn hasn't finished.
      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'dm1', '👀');
      expect(adapter.addReaction).not.toHaveBeenCalledWith('c1', 'dm1', '✅');

      // ✅ means "answer ready": fires when the instance goes idle.
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'idle' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'dm1', '✅');
    });
  });

  // -------------------------------------------------------------------------
  // Thread routing
  // -------------------------------------------------------------------------

  describe('thread routing', () => {
    it('routes to existing instance when thread resolves', async () => {
      persistence.resolveInstanceByThread.mockReturnValue('existing-inst');
      const msg = makeMessage({ threadId: 'thread-1', content: 'follow up' });
      await router.handleInboundMessage(msg);

      expect(instanceManager.sendInput).toHaveBeenCalledWith(
        'existing-inst',
        expect.stringContaining('<channel_message>\nfollow up\n</channel_message>'),
      );
      expect(instanceManager.createInstance).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Explicit routing (@instance-<id>)
  // -------------------------------------------------------------------------

  describe('explicit routing', () => {
    it('routes @instance-<id> to the specified instance', async () => {
      const msg = makeMessage({ content: '@instance-3 do this task' });
      await router.handleInboundMessage(msg);

      expect(instanceManager.sendInput).toHaveBeenCalledWith(
        '3',
        expect.stringContaining('<channel_message>\ndo this task\n</channel_message>'),
      );
      expect(instanceManager.createInstance).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Broadcast routing (@all)
  // -------------------------------------------------------------------------

  describe('broadcast routing', () => {
    it('sends to all active instances', async () => {
      instanceManager.getInstances.mockReturnValue([
        { id: 'a', status: 'idle' },
        { id: 'b', status: 'busy' },
        { id: 'c', status: 'hibernated' },
      ]);
      const msg = makeMessage({ content: '@all stop everything' });
      await router.handleInboundMessage(msg);

      // Should have sent to a and b (idle/busy), not c (hibernated)
      expect(instanceManager.sendInput).toHaveBeenCalledWith(
        'a',
        expect.stringContaining('<channel_message>\nstop everything\n</channel_message>'),
      );
      expect(instanceManager.sendInput).toHaveBeenCalledWith(
        'b',
        expect.stringContaining('<channel_message>\nstop everything\n</channel_message>'),
      );
      expect(instanceManager.sendInput).not.toHaveBeenCalledWith('c', expect.anything());
    });

    it('sends "no active instances" message when there are none', async () => {
      instanceManager.getInstances.mockReturnValue([]);
      const msg = makeMessage({ content: '@all stop everything', chatId: 'c1', messageId: 'dm1' });
      await router.handleInboundMessage(msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'No active instances to broadcast to.',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('announces broadcast count before sending', async () => {
      instanceManager.getInstances.mockReturnValue([
        { id: 'a', status: 'idle' },
        { id: 'b', status: 'idle' },
      ]);
      const msg = makeMessage({ content: '@all go', chatId: 'c1', messageId: 'dm1' });
      await router.handleInboundMessage(msg);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Broadcasting to 2 instances...',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });
  });

  describe('session listing and revival', () => {
    it('shows projects with active and revivable counts without listing sleeping session names globally', async () => {
      recentDirectoriesState.entries = [
        { path: '/work/project-a', displayName: 'Project A', lastAccessed: 3000 },
      ];
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'active-1',
          status: 'idle',
          displayName: 'Live Session',
          workingDirectory: '/work/project-a',
          lastActivity: 5000,
        },
        {
          id: 'sleep-1',
          status: 'hibernated',
          displayName: 'Sleeping Session',
          workingDirectory: '/work/project-a',
          lastActivity: 4000,
        },
      ]);
      hibernatedInstancesState.entries = [
        {
          instanceId: 'sleep-1',
          displayName: 'Sleeping Session',
          agentId: 'build',
          sessionState: {},
          hibernatedAt: 4000,
          workingDirectory: '/work/project-a',
        },
      ];
      historyEntriesState.entries = [
        {
          id: 'archived-1',
          workingDirectory: '/work/project-a',
          firstUserMessage: 'Old archived request',
          createdAt: 1000,
          endedAt: 2000,
        },
      ];

      await router.handleInboundMessage(makeMessage({ chatId: 'c1', messageId: 'dm1', content: '/list' }));

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        expect.stringContaining('**1.** **Project A** : 1 active, 1 revivable'),
        expect.objectContaining({ replyTo: 'dm1' }),
      );
      const content = adapter.sendMessage.mock.calls[0][1];
      expect(content).not.toContain('Sleeping Session');
      expect(content).not.toContain('Old archived request');
    });

    it('drills into a project with active sessions first and revivable sessions separated', async () => {
      recentDirectoriesState.entries = [
        { path: '/work/project-a', displayName: 'Project A', lastAccessed: 3000 },
      ];
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'active-1',
          status: 'idle',
          displayName: 'Live Session',
          workingDirectory: '/work/project-a',
          lastActivity: 5000,
        },
        {
          id: 'sleep-1',
          status: 'hibernated',
          displayName: 'Sleeping Session',
          workingDirectory: '/work/project-a',
          lastActivity: 4000,
        },
      ]);
      hibernatedInstancesState.entries = [
        {
          instanceId: 'sleep-1',
          displayName: 'Sleeping Session',
          agentId: 'build',
          sessionState: {},
          hibernatedAt: 4000,
          workingDirectory: '/work/project-a',
        },
      ];
      historyEntriesState.entries = [
        {
          id: 'archived-1',
          workingDirectory: '/work/project-a',
          firstUserMessage: 'Old archived request',
          createdAt: 1000,
          endedAt: 2000,
        },
      ];

      await router.handleInboundMessage(makeMessage({ chatId: 'c1', messageId: 'dm1', content: '/list Project A' }));

      const content = adapter.sendMessage.mock.calls[0][1];
      expect(content).toContain('Active sessions:');
      expect(content).toContain('* Live Session — idle');
      expect(content).toContain('Revivable sessions:');
      expect(content).toContain('* Sleeping Session — hibernated');
      expect(content).not.toContain('Old archived request');
    });

    it('keeps /pick active-only and excludes hibernated sessions', async () => {
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'active-1',
          status: 'idle',
          displayName: 'Live Session',
          workingDirectory: '/work/project-a',
          lastActivity: 5000,
        },
        {
          id: 'sleep-1',
          status: 'hibernated',
          displayName: 'Sleeping Session',
          workingDirectory: '/work/project-a',
          lastActivity: 4000,
        },
      ]);
      hibernatedInstancesState.entries = [
        {
          instanceId: 'sleep-1',
          displayName: 'Sleeping Session',
          agentId: 'build',
          sessionState: {},
          hibernatedAt: 4000,
          workingDirectory: '/work/project-a',
        },
      ];

      await router.handleInboundMessage(makeMessage({ chatId: 'c1', messageId: 'dm1', content: '/pick' }));

      const content = adapter.sendMessage.mock.calls[0][1];
      expect(content).toContain('Live Session');
      expect(content).not.toContain('Sleeping Session');
      expect(content).not.toContain('Hibernated instances');
    });

    it('wakes a hibernated session before routing input to it', async () => {
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'sleep-1',
          status: 'hibernated',
          displayName: 'Sleeping Session',
          workingDirectory: '/work/project-a',
          lastActivity: 4000,
        },
      ]);
      hibernatedInstancesState.entries = [
        {
          instanceId: 'sleep-1',
          displayName: 'Sleeping Session',
          agentId: 'build',
          sessionState: {},
          hibernatedAt: 4000,
          workingDirectory: '/work/project-a',
        },
      ];

      await router.handleInboundMessage(
        makeMessage({ content: '@project-a continue this work' }),
      );

      expect(instanceManager.wakeInstance).toHaveBeenCalledWith('sleep-1');
      expect(instanceManager.sendInput).toHaveBeenCalledWith(
        'sleep-1',
        expect.stringContaining('<channel_message>\ncontinue this work\n</channel_message>'),
      );
      expect(instanceManager.createInstance).not.toHaveBeenCalled();
    });

    it('revives a project session and persists the selected channel pin', async () => {
      recentDirectoriesState.entries = [
        { path: '/work/project-a', displayName: 'Project A', lastAccessed: 3000 },
      ];
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'sleep-1',
          status: 'hibernated',
          displayName: 'Sleeping Session',
          workingDirectory: '/work/project-a',
          lastActivity: 4000,
        },
      ]);
      hibernatedInstancesState.entries = [
        {
          instanceId: 'sleep-1',
          displayName: 'Sleeping Session',
          agentId: 'build',
          sessionState: {},
          hibernatedAt: 4000,
          workingDirectory: '/work/project-a',
        },
      ];

      await router.handleInboundMessage(makeMessage({
        chatId: 'channel-1',
        messageId: 'revive-1',
        content: '/revive Project A',
        isDM: false,
        isGroup: true,
      }));

      expect(instanceManager.wakeInstance).toHaveBeenCalledWith('sleep-1');
      expect(routeStore.savePin).toHaveBeenCalledWith(
        'discord',
        'chat',
        'channel-1',
        { kind: 'instance', instanceId: 'sleep-1' },
      );
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'channel-1',
        expect.stringContaining('Revived and selected'),
        expect.objectContaining({
          replyTo: 'revive-1',
          actions: expect.arrayContaining([
            expect.objectContaining({ label: 'Stop' }),
            expect.objectContaining({ label: 'Continue' }),
          ]),
        }),
      );
    });

    it('shows whereami using a persisted channel project pin', async () => {
      routeStore.savePin('discord', 'chat', 'channel-1', {
        kind: 'project',
        projectKey: '/work/project-a',
        label: 'Project A',
        workingDirectory: '/work/project-a',
      });
      recentDirectoriesState.entries = [
        { path: '/work/project-a', displayName: 'Project A', lastAccessed: 3000 },
      ];

      await router.handleInboundMessage(makeMessage({
        chatId: 'channel-1',
        messageId: 'where-1',
        content: '/whereami',
        isDM: false,
        isGroup: true,
      }));

      const content = adapter.sendMessage.mock.calls[0][1];
      expect(content).toContain('Channel pin: project **Project A**');
      expect(content).toContain('Path: `/work/project-a`');
    });
  });

  describe('discord admin and attachment commands', () => {
    it('lets Discord admins allow a sender and persists the access policy', async () => {
      await router.handleInboundMessage(makeMessage({
        content: '/allow 222222',
        senderIsAdmin: true,
        chatId: 'admin-chan',
        messageId: 'allow-1',
      }));

      expect(adapter.setAccessPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedSenders: expect.arrayContaining(['user-1', '222222']),
        }),
      );
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'admin-chan',
        'Allowed Discord user `222222`.',
        expect.objectContaining({ replyTo: 'allow-1' }),
      );
    });

    it('rejects allow commands from non-admin Discord users', async () => {
      await router.handleInboundMessage(makeMessage({
        content: '/allow 222222',
        senderIsAdmin: false,
        chatId: 'admin-chan',
        messageId: 'allow-2',
      }));

      expect(adapter.setAccessPolicy).not.toHaveBeenCalled();
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'admin-chan',
        expect.stringContaining('administrator permission is required'),
        expect.objectContaining({ replyTo: 'allow-2' }),
      );
    });

    it('downloads Discord attachments and passes them into new session creation', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        arrayBuffer: async () => new TextEncoder().encode('hello file').buffer,
      })));

      await router.handleInboundMessage(makeMessage({
        content: 'inspect this file',
        attachments: [
          {
            name: 'note.txt',
            type: 'text/plain',
            size: 10,
            url: 'https://cdn.discordapp.test/note.txt',
          },
        ],
        chatId: 'attach-chan',
        messageId: 'attach-1',
      }));

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'attach-chan',
        'Attached 1 file to the session.',
        expect.objectContaining({ replyTo: 'attach-1' }),
      );
      expect(instanceManager.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            expect.objectContaining({
              name: 'note.txt',
              type: 'text/plain',
              data: expect.stringContaining('data:text/plain;base64,'),
            }),
          ],
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Output debounce / streaming
  // -------------------------------------------------------------------------

  describe('output debounce', () => {
    it('batches output for 2 seconds before sending back to channel', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-1', chatId: 'c1', messageId: 'dm1' }));

      // Emit two output chunks from the created instance
      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Hello '));
      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'World'));

      // Nothing sent yet (debounce hasn't fired)
      expect(adapter.sendMessage).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Hello World',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('saves the outbound message to persistence after debounce', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-2', chatId: 'c1', messageId: 'dm1' }));

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Response text'));

      await vi.advanceTimersByTimeAsync(2000);

      expect(persistence.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'outbound',
          content: 'Response text',
          instance_id: 'inst-1',
          message_id: 'sent-1',
          reply_to_message_id: 'dm1',
        })
      );
      expect(channelManager.emitResponseSent).toHaveBeenCalledWith(
        expect.objectContaining({
          channelMessageId: 'dm1',
          platform: 'discord',
          chatId: 'c1',
          messageId: 'sent-1',
          instanceId: 'inst-1',
          content: 'Response text',
          status: 'complete',
        })
      );
    });

    it('ignores output from other instances', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-3' }));

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('other-inst', 'Not mine'));

      await vi.advanceTimersByTimeAsync(2000);

      // sendMessage was called for eyes/check reactions only (addReaction), not sendMessage
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('continues streaming output after the first debounce flush', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-4', chatId: 'c1', messageId: 'dm1' }));

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'First burst'));

      await vi.advanceTimersByTimeAsync(2000);

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Second burst'));

      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendMessage).toHaveBeenNthCalledWith(
        1,
        'c1',
        'First burst',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
      expect(adapter.sendMessage).toHaveBeenNthCalledWith(
        2,
        'c1',
        'Second burst',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('tags only the first DM reply with the configured bot name', async () => {
      vi.useFakeTimers();
      adapter.getDisplayName.mockReturnValue('Mac Bot');

      await router.handleInboundMessage(makeMessage({ id: 'tag-1', chatId: 'c1', messageId: 'dm1', isDM: true }));

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'First'));
      await vi.advanceTimersByTimeAsync(2000);
      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Second'));
      await vi.advanceTimersByTimeAsync(2000);

      // First message of the reply is tagged; continuation messages are not.
      expect(adapter.sendMessage).toHaveBeenNthCalledWith(
        1,
        'c1',
        '**Mac Bot**\nFirst',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
      expect(adapter.sendMessage).toHaveBeenNthCalledWith(
        2,
        'c1',
        'Second',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('does not tag replies in a server channel (nickname covers that)', async () => {
      vi.useFakeTimers();
      adapter.getDisplayName.mockReturnValue('Mac Bot');

      await router.handleInboundMessage(
        makeMessage({ id: 'tag-2', chatId: 'c1', messageId: 'dm1', isDM: false, isGroup: true }),
      );

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Server reply'));
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Server reply',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('stops streaming once the instance reaches a terminal state', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-5', chatId: 'c1', messageId: 'dm1' }));

      instanceManager.emit('instance:state-update', {
        instanceId: 'inst-1',
        status: 'idle',
      });

      await vi.advanceTimersByTimeAsync(2000);

      adapter.sendMessage.mockClear();

      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'Late output'));

      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('does not duplicate output when multiple inbound messages target the same instance', async () => {
      // Regression: previously every inbound message keyed an output tracker by
      // its random msg.id, so each /continue button click attached a fresh
      // listener to provider:normalized-event and the same chunk was sent to
      // Discord N times. See channel-message-router.streamResults.
      vi.useFakeTimers();

      // Both inbound messages route to the same instance via thread persistence.
      persistence.resolveInstanceByThread.mockReturnValue('inst-1');

      await router.handleInboundMessage(makeMessage({
        id: 'dup-1',
        chatId: 'c1',
        messageId: 'm1',
        threadId: 'thread-dup',
        content: 'first prompt',
      }));

      await router.handleInboundMessage(makeMessage({
        id: 'dup-2',
        chatId: 'c1',
        messageId: 'm2',
        threadId: 'thread-dup',
        content: 'second prompt',
      }));

      adapter.sendMessage.mockClear();

      // Single output chunk from the instance should produce a single Discord send.
      instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', 'one chunk'));

      await vi.advanceTimersByTimeAsync(2000);

      const streamSends = adapter.sendMessage.mock.calls.filter(
        (call) => call[1] === 'one chunk',
      );
      expect(streamSends).toHaveLength(1);
      // And the stream replies to the latest user prompt, not the stale first one.
      expect(streamSends[0][2]).toMatchObject({ replyTo: 'm2' });
    });

    it('emits the suppression notice only once across repeated inbound messages', async () => {
      // Regression: each per-msg tracker hit its own MAX_LIVE_STREAM_FLUSHES
      // budget independently, so users saw multiple "Output is still streaming"
      // notices when they clicked /continue while the AI was busy.
      vi.useFakeTimers();

      persistence.resolveInstanceByThread.mockReturnValue('inst-1');

      // Five user prompts arrive while the instance keeps streaming.
      for (let i = 0; i < 5; i++) {
        await router.handleInboundMessage(makeMessage({
          id: `sup-${i}`,
          chatId: 'c1',
          messageId: `mm${i}`,
          threadId: 'thread-sup',
          content: `prompt ${i}`,
        }));
      }

      adapter.sendMessage.mockClear();

      // Push enough chunks to exceed MAX_LIVE_STREAM_FLUSHES (3) and trigger
      // the suppression branch.
      for (let i = 0; i < 6; i++) {
        instanceManager.emit('provider:normalized-event', makeOutputEnvelope('inst-1', `chunk ${i} `));
        await vi.advanceTimersByTimeAsync(2000);
      }

      const suppressionSends = adapter.sendMessage.mock.calls.filter(
        (call) => typeof call[1] === 'string' && call[1].startsWith('Output is still streaming.'),
      );
      expect(suppressionSends).toHaveLength(1);
    });

    it('relays a first-turn reply already buffered before the listener attached', async () => {
      // Regression (echo-back): for a freshly-created instance, createInstance
      // resolves only after the first turn has settled, so the assistant reply
      // is already in the outputBuffer and NO live provider:normalized-event
      // arrives for it. The relay must drain the buffer on attach or the reply
      // silently never reaches the channel.
      vi.useFakeTimers();

      instanceManager.getInstances.mockReturnValue([
        {
          id: 'inst-1',
          status: 'idle',
          outputBuffer: [
            { id: 'a1', type: 'assistant', content: 'Hi James! 👋 What can I help you with today?' },
          ],
        },
      ]);

      await router.handleInboundMessage(makeMessage({ id: 'race-1', chatId: 'c1', messageId: 'dm1' }));

      // No live event is emitted — only the buffered reply exists.
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Hi James! 👋 What can I help you with today?',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('does not double-post a buffered reply when a matching live event also arrives', async () => {
      vi.useFakeTimers();

      instanceManager.getInstances.mockReturnValue([
        {
          id: 'inst-1',
          status: 'busy',
          outputBuffer: [{ id: 'a1', type: 'assistant', content: 'Buffered reply' }],
        },
      ]);

      await router.handleInboundMessage(makeMessage({ id: 'dedup-1', chatId: 'c1', messageId: 'dm1' }));

      // A live event carrying the SAME message id as the replayed one must be
      // ignored so the reply is not posted twice.
      instanceManager.emit('provider:normalized-event', {
        eventId: 'inst-1-live',
        seq: 1,
        timestamp: 1000,
        provider: 'claude',
        instanceId: 'inst-1',
        event: { kind: 'output', content: 'Buffered reply', messageType: 'assistant', messageId: 'a1' },
      } as ProviderRuntimeEventEnvelope);

      await vi.advanceTimersByTimeAsync(2000);

      const replySends = adapter.sendMessage.mock.calls.filter((call) => call[1] === 'Buffered reply');
      expect(replySends).toHaveLength(1);
    });

    it('does not replay prior history when routing to an existing instance', async () => {
      // The existing-instance path attaches the listener before sendInput and
      // must NOT drain the outputBuffer, or old conversation turns would be
      // re-posted to the channel on every new message.
      vi.useFakeTimers();

      persistence.resolveInstanceByThread.mockReturnValue('inst-1');
      instanceManager.getInstances.mockReturnValue([
        {
          id: 'inst-1',
          status: 'idle',
          outputBuffer: [{ id: 'old-1', type: 'assistant', content: 'stale prior answer' }],
        },
      ]);

      await router.handleInboundMessage(makeMessage({
        id: 'existing-1',
        chatId: 'c1',
        messageId: 'm1',
        threadId: 'thread-existing',
        content: 'follow up',
      }));

      await vi.advanceTimersByTimeAsync(2000);

      const staleSends = adapter.sendMessage.mock.calls.filter((call) => call[1] === 'stale prior answer');
      expect(staleSends).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('sends error reaction and message when routing fails', async () => {
      instanceManager.createInstance.mockRejectedValue(new Error('spawn failed'));
      const msg = makeMessage({ chatId: 'c1', messageId: 'dm1', content: 'do work' });
      await router.handleInboundMessage(msg);

      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'dm1', '❌');
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Error: spawn failed',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('does nothing when no adapter is registered for the platform', async () => {
      (channelManager.getAdapter as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      await expect(router.handleInboundMessage(makeMessage())).resolves.toBeUndefined();
      expect(instanceManager.createInstance).not.toHaveBeenCalled();
    });
  });

  describe('remote-node commands', () => {
    it('enables browser auto-offloading via /offload browser', async () => {
      await router.handleInboundMessage(
        makeMessage({ chatId: 'c1', messageId: 'dm1', content: '/offload browser' }),
      );

      expect(updateRemoteNodeConfigMock).toHaveBeenCalledWith({ autoOffloadBrowser: true });
      expect(settingsSetMock).toHaveBeenCalledWith('remoteNodesAutoOffloadBrowser', true);
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Browser auto-offloading enabled.',
        expect.objectContaining({ replyTo: 'dm1' }),
      );
    });

    it('disables browser auto-offloading via /offload browser off', async () => {
      remoteNodeConfigState.autoOffloadBrowser = true;

      await router.handleInboundMessage(
        makeMessage({ chatId: 'c1', messageId: 'dm2', content: '/offload browser off' }),
      );

      expect(updateRemoteNodeConfigMock).toHaveBeenCalledWith({ autoOffloadBrowser: false });
      expect(settingsSetMock).toHaveBeenCalledWith('remoteNodesAutoOffloadBrowser', false);
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        'c1',
        'Browser auto-offloading disabled.',
        expect.objectContaining({ replyTo: 'dm2' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // assertSendable
  // -------------------------------------------------------------------------

  describe('assertSendable', () => {
    it('allows normal file paths', () => {
      expect(() => router.assertSendable('/home/user/project/report.pdf')).not.toThrow();
      expect(() => router.assertSendable('/tmp/output.txt')).not.toThrow();
    });

    it('blocks paths containing .env', () => {
      expect(() => router.assertSendable('/app/.env')).toThrow('Cannot send file from restricted path');
    });

    it('blocks paths containing credentials', () => {
      expect(() => router.assertSendable('/app/credentials/key.json')).toThrow();
    });

    it('blocks paths containing tokens', () => {
      expect(() => router.assertSendable('/config/tokens/auth.json')).toThrow();
    });

    it('blocks paths containing secrets', () => {
      expect(() => router.assertSendable('/etc/secrets/db_pass')).toThrow();
    });

    it('blocks paths containing .ssh', () => {
      expect(() => router.assertSendable('/home/user/.ssh/id_rsa')).toThrow();
    });

    it('blocks paths containing access.json', () => {
      expect(() => router.assertSendable('/app/access.json')).toThrow();
    });

    it('blocks paths with mixed case (case-insensitive check)', () => {
      expect(() => router.assertSendable('/app/.ENV')).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // §2 — safe default working directory for context-less new instances
  // -------------------------------------------------------------------------

  describe('safe default working directory (§2)', () => {
    it('never spawns a context-less instance at the filesystem root', async () => {
      // No recent directories → fall back to the home dir, never process.cwd()
      // (which is "/" for the packaged app and triggered whole-FS repo scans).
      recentDirectoriesState.entries = [];

      await router.handleInboundMessage(makeMessage({ content: 'hi' }));

      const call = (instanceManager.createInstance.mock.calls[0] as unknown as [{ workingDirectory?: string }])?.[0];
      expect(call?.workingDirectory).toBeTruthy();
      expect(call?.workingDirectory).not.toBe('/');
      expect(call?.workingDirectory).toBe(os.homedir());
    });

    it('prefers the most-recent existing project directory', async () => {
      recentDirectoriesState.entries = [
        { path: os.tmpdir(), displayName: 'tmp', lastAccessed: 2000 },
        { path: '/nonexistent-xyz', displayName: 'gone', lastAccessed: 3000 },
      ];

      await router.handleInboundMessage(makeMessage({ content: 'hi' }));

      const call = (instanceManager.createInstance.mock.calls[0] as unknown as [{ workingDirectory?: string }])?.[0];
      // The non-existent (higher lastAccessed) entry is skipped; the existing
      // tmp dir is chosen over the home-dir fallback.
      expect(call?.workingDirectory).toBe(os.tmpdir());
    });
  });

  // -------------------------------------------------------------------------
  // Backlog #1 — surface approval / question prompts to the channel
  // -------------------------------------------------------------------------

  describe('agent prompts (backlog #1)', () => {
    async function routeInitialTurn(): Promise<void> {
      instanceManager.getInstances.mockReturnValue([
        { id: 'inst-1', status: 'busy', outputBuffer: [] },
      ]);
      router.start();
      await router.handleInboundMessage(
        makeMessage({ id: 'seed', chatId: 'c1', messageId: 'm1', content: 'do a thing' }),
      );
      adapter.sendMessage.mockClear();
    }

    it('posts a permission prompt to the chat watching the instance', async () => {
      await routeInitialTurn();

      instanceManager.emit('instance:input-required', {
        instanceId: 'inst-1',
        requestId: 'req-1',
        prompt: 'Run rm -rf build?',
        metadata: { tool_name: 'Bash' },
      });
      await Promise.resolve();

      const promptSend = adapter.sendMessage.mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('needs approval'),
      );
      expect(promptSend).toBeDefined();
      expect(promptSend?.[0]).toBe('c1');
      const options = promptSend?.[2] as SendOptions | undefined;
      expect(options?.actions?.map((a) => a.id)).toEqual([
        'orch:approve:req-1',
        'orch:reject:req-1',
      ]);
    });

    it('does not post when no channel is watching the instance', async () => {
      router.start();
      adapter.sendMessage.mockClear();

      instanceManager.emit('instance:input-required', {
        instanceId: 'unknown-inst',
        requestId: 'req-x',
        prompt: 'proceed?',
      });
      await Promise.resolve();

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('resumes the agent when the user approves via the button command', async () => {
      await routeInitialTurn();
      instanceManager.emit('instance:input-required', {
        instanceId: 'inst-1',
        requestId: 'req-1',
        prompt: 'proceed?',
        metadata: { tool_name: 'Bash' },
      });
      await Promise.resolve();

      // The Approve button maps to `/approve req-1`.
      await router.handleInboundMessage(
        makeMessage({ id: 'btn', chatId: 'c1', messageId: 'b1', content: '/approve req-1' }),
      );

      expect(instanceManager.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', true);
      expect(instanceManager.clearPendingInputRequiredPermission).toHaveBeenCalledWith('inst-1', 'req-1');
    });

    it('denies the agent when the user replies "no"', async () => {
      await routeInitialTurn();
      instanceManager.emit('instance:input-required', {
        instanceId: 'inst-1',
        requestId: 'req-1',
        prompt: 'proceed?',
        metadata: { tool_name: 'Bash' },
      });
      await Promise.resolve();

      await router.handleInboundMessage(
        makeMessage({ id: 'reply', chatId: 'c1', messageId: 'r1', content: 'no' }),
      );

      expect(instanceManager.resumeAfterDeferredPermission).toHaveBeenCalledWith('inst-1', false);
      // A denied plain reply must not also be routed as a new turn.
      expect(instanceManager.sendInput).not.toHaveBeenCalledWith(
        'inst-1',
        expect.stringContaining('no'),
        expect.anything(),
      );
    });

    it('routes a select_option answer back via respondToUserAction', async () => {
      await routeInitialTurn();
      const orchestration = instanceManager.getOrchestrationHandler();

      orchestration.emit('user-action-request', {
        id: 'uar-1',
        instanceId: 'inst-1',
        requestType: 'select_option',
        title: 'Pick a branch',
        message: 'Which branch?',
        options: [
          { id: 'main', label: 'main' },
          { id: 'dev', label: 'dev' },
        ],
      });
      await Promise.resolve();

      const promptSend = adapter.sendMessage.mock.calls.find(
        (call) => typeof call[1] === 'string' && call[1].includes('Pick a branch'),
      );
      expect(promptSend).toBeDefined();
      const options = promptSend?.[2] as SendOptions | undefined;
      expect(options?.actions?.[0]?.id).toBe('orch:answer:uar-1~main');

      // The option button maps to `/answer uar-1 dev`.
      await router.handleInboundMessage(
        makeMessage({ id: 'ans', chatId: 'c1', messageId: 'a1', content: '/answer uar-1 dev' }),
      );

      expect(orchestration.respondToUserAction).toHaveBeenCalledWith('uar-1', true, 'dev');
    });

    it('forwards a free-text answer for an ask_questions prompt', async () => {
      await routeInitialTurn();
      const orchestration = instanceManager.getOrchestrationHandler();

      orchestration.emit('user-action-request', {
        id: 'uar-2',
        instanceId: 'inst-1',
        requestType: 'ask_questions',
        title: 'Need details',
        message: 'A couple of questions:',
        questions: ['Which environment?', 'Deploy now?'],
      });
      await Promise.resolve();

      await router.handleInboundMessage(
        makeMessage({ id: 'free', chatId: 'c1', messageId: 'f1', content: 'staging, not yet' }),
      );

      expect(orchestration.respondToUserAction).toHaveBeenCalledWith('uar-2', true, 'staging, not yet');
      // The free-text answer must not also start a fresh turn.
      expect(instanceManager.createInstance).toHaveBeenCalledTimes(1);
    });

    it('clears a pending prompt when the instance leaves the waiting state', async () => {
      await routeInitialTurn();
      instanceManager.emit('instance:input-required', {
        instanceId: 'inst-1',
        requestId: 'req-1',
        prompt: 'proceed?',
        metadata: { tool_name: 'Bash' },
      });
      await Promise.resolve();

      // Answered elsewhere (mobile/renderer) → instance goes back to idle.
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'idle' });

      // A subsequent plain reply must NOT be swallowed as an approval; it routes
      // normally to the pinned instance instead.
      instanceManager.resumeAfterDeferredPermission.mockClear();
      await router.handleInboundMessage(
        makeMessage({ id: 'later', chatId: 'c1', messageId: 'l1', content: 'yes' }),
      );

      expect(instanceManager.resumeAfterDeferredPermission).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Mobile-parity streaming (#2 completion, #3 attachments, #4 heartbeat,
  // #5 DM ping) + first-turn prompt race (residual)
  // -------------------------------------------------------------------------

  describe('mobile-parity streaming', () => {
    async function routeTurn(status = 'busy'): Promise<void> {
      instanceManager.getInstances.mockReturnValue([{ id: 'inst-1', status, outputBuffer: [] }]);
      await router.handleInboundMessage(
        makeMessage({ id: 'seed', chatId: 'c1', messageId: 'm1', content: 'do work' }),
      );
    }

    it('marks a failed turn with a warning reaction, not ✅ (#2)', async () => {
      vi.useFakeTimers();
      await routeTurn();
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'failed' });
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'm1', '⚠️');
      expect(adapter.addReaction).not.toHaveBeenCalledWith('c1', 'm1', '✅');
    });

    it('finalizes with ✅ when a freshly-created instance is already idle at attach (#2)', async () => {
      vi.useFakeTimers();
      // getInstance('inst-1') reports idle — the first turn settled before attach.
      instanceManager.getInstances.mockReturnValue([{ id: 'inst-1', status: 'idle', outputBuffer: [] }]);
      await router.handleInboundMessage(
        makeMessage({ id: 'seed', chatId: 'c1', messageId: 'm1', content: 'do work' }),
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'm1', '✅');
    });

    it('relays agent-produced attachments as channel files (#3)', async () => {
      vi.useFakeTimers();
      await routeTurn();

      instanceManager.emit(
        'provider:normalized-event',
        makeEnvelope('inst-1', {
          content: 'Here is the chart',
          messageId: 'a1',
          attachments: [{ name: 'chart.txt', type: 'text/plain', size: 2, data: dataUrl('hi') }],
        }),
      );
      await vi.advanceTimersByTimeAsync(2000);

      expect(adapter.sendFile).toHaveBeenCalledTimes(1);
      expect(adapter.sendFile.mock.calls[0][0]).toBe('c1');
    });

    it('does not relay the same attachment twice across flushes (#3)', async () => {
      vi.useFakeTimers();
      await routeTurn();

      const attachment = { name: 'a.txt', type: 'text/plain', size: 2, data: dataUrl('hi') };
      for (let i = 0; i < 2; i++) {
        instanceManager.emit(
          'provider:normalized-event',
          makeEnvelope('inst-1', { content: `chunk ${i} `, messageId: `a${i}`, attachments: [attachment] }),
        );
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(adapter.sendFile).toHaveBeenCalledTimes(1);
    });

    it('posts an opt-in tool heartbeat only after the throttle interval (#4)', async () => {
      vi.useFakeTimers();
      settingsState.channelToolHeartbeat = true;
      await routeTurn();

      // Immediately: within the throttle window → no heartbeat.
      instanceManager.emit(
        'provider:normalized-event',
        makeEnvelope('inst-1', { messageType: 'tool_use', metadata: { tool_name: 'Bash' } }),
      );
      expect(adapter.sendMessage).not.toHaveBeenCalledWith(
        'c1',
        expect.stringContaining('still working'),
        expect.anything(),
      );

      // After 31s of activity → one heartbeat line.
      await vi.advanceTimersByTimeAsync(31_000);
      instanceManager.emit(
        'provider:normalized-event',
        makeEnvelope('inst-1', { messageType: 'tool_use', metadata: { tool_name: 'Bash' } }),
      );

      const heartbeat = adapter.sendMessage.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].includes('still working'),
      );
      expect(heartbeat?.[1]).toContain('running Bash');
    });

    it('does not post a heartbeat when the setting is off (#4)', async () => {
      vi.useFakeTimers();
      settingsState.channelToolHeartbeat = false;
      await routeTurn();

      await vi.advanceTimersByTimeAsync(31_000);
      instanceManager.emit(
        'provider:normalized-event',
        makeEnvelope('inst-1', { messageType: 'tool_use', metadata: { tool_name: 'Bash' } }),
      );

      expect(adapter.sendMessage).not.toHaveBeenCalledWith(
        'c1',
        expect.stringContaining('still working'),
        expect.anything(),
      );
    });

    it('sends a completion ping for a long, silent DM turn (#5)', async () => {
      vi.useFakeTimers();
      await routeTurn();

      await vi.advanceTimersByTimeAsync(25_000); // exceed DM_COMPLETION_PING_MIN_MS
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'idle' });
      await vi.advanceTimersByTimeAsync(2000);

      const ping = adapter.sendMessage.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].startsWith('✅ Finished'),
      );
      expect(ping).toBeDefined();
    });

    it('does not send a completion ping when the turn produced text (#5)', async () => {
      vi.useFakeTimers();
      await routeTurn();

      await vi.advanceTimersByTimeAsync(25_000);
      // The turn produced an assistant reply → the reply message is the notification.
      instanceManager.emit(
        'provider:normalized-event',
        makeEnvelope('inst-1', { content: 'done', messageId: 'a1' }),
      );
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'idle' });
      await vi.advanceTimersByTimeAsync(2000);

      const ping = adapter.sendMessage.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].startsWith('✅ Finished'),
      );
      expect(ping).toBeUndefined();
    });

    it('does not ping for a short silent DM turn (#5)', async () => {
      vi.useFakeTimers();
      await routeTurn();

      await vi.advanceTimersByTimeAsync(2000); // well under the threshold
      instanceManager.emit('instance:state-update', { instanceId: 'inst-1', status: 'idle' });
      await vi.advanceTimersByTimeAsync(2000);

      const ping = adapter.sendMessage.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].startsWith('✅ Finished'),
      );
      expect(ping).toBeUndefined();
    });

    it('buffers a prompt raised before a watcher exists and posts it on attach (residual)', async () => {
      router.start();

      // A permission prompt arrives during the first turn — no chat is watching
      // inst-1 yet, so nothing is posted.
      instanceManager.emit('instance:input-required', {
        instanceId: 'inst-1',
        requestId: 'req-early',
        prompt: 'proceed?',
        metadata: { tool_name: 'Bash' },
      });
      await Promise.resolve();
      expect(adapter.sendMessage).not.toHaveBeenCalledWith(
        'c1',
        expect.stringContaining('needs approval'),
        expect.anything(),
      );

      // Now the instance's output tracker attaches (createInstance resolved) →
      // the buffered prompt is flushed to the watching chat.
      instanceManager.getInstances.mockReturnValue([{ id: 'inst-1', status: 'busy', outputBuffer: [] }]);
      await router.handleInboundMessage(
        makeMessage({ id: 'seed', chatId: 'c1', messageId: 'm1', content: 'do work' }),
      );

      const promptSend = adapter.sendMessage.mock.calls.find(
        (c) => typeof c[1] === 'string' && c[1].includes('needs approval'),
      );
      expect(promptSend?.[0]).toBe('c1');
    });
  });
});
