import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ChannelMessageRouter } from '../channel-message-router';
import type { ChannelManager, ChannelEvent } from '../channel-manager';
import type { ChannelPersistence } from '../channel-persistence';
import type { ChannelRouteStore, SavedChannelRoutePin } from '../channel-route-store';
import type { AccessPolicy, InboundChannelMessage, SentMessage } from '../../../shared/types/channels';
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

interface MockInstanceRecord {
  id: string;
  status: string;
  displayName?: string;
  workingDirectory?: string;
  lastActivity?: number;
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
    sendMessage: vi.fn(async () => makeSentMessage()),
    addReaction: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => makeSentMessage()),
    editMessage: vi.fn(async () => undefined),
    getAccessPolicy: vi.fn(() => accessPolicy),
    setAccessPolicy: vi.fn((nextPolicy: AccessPolicy) => {
      accessPolicy = nextPolicy;
    }),
  };
}

function makeMockPersistence() {
  return {
    saveMessage: vi.fn(),
    resolveInstanceByThread: vi.fn(() => null as string | null),
    updateInstanceId: vi.fn(),
  };
}

function makeMockInstanceManager() {
  const em = new EventEmitter();
  const getInstances = vi.fn(() => [] as MockInstanceRecord[]);
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
          initialPrompt: 'run this task',
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

    it('adds eyes reaction on receipt and check reaction on completion', async () => {
      const msg = makeMessage({ chatId: 'c1', messageId: 'dm1' });
      await router.handleInboundMessage(msg);
      expect(adapter.addReaction).toHaveBeenCalledWith('c1', 'dm1', '👀');
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

      expect(instanceManager.sendInput).toHaveBeenCalledWith('existing-inst', 'follow up');
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

      expect(instanceManager.sendInput).toHaveBeenCalledWith('3', 'do this task');
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
      expect(instanceManager.sendInput).toHaveBeenCalledWith('a', 'stop everything');
      expect(instanceManager.sendInput).toHaveBeenCalledWith('b', 'stop everything');
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
      expect(instanceManager.sendInput).toHaveBeenCalledWith('sleep-1', 'continue this work');
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
});
