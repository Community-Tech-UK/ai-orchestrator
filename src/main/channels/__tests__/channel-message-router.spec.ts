import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { ChannelMessageRouter } from '../channel-message-router';
import type { ChannelManager, ChannelEvent } from '../channel-manager';
import type { ChannelPersistence } from '../channel-persistence';
import type { InboundChannelMessage, SentMessage } from '../../../shared/types/channels';

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

function makeSentMessage(overrides: Partial<SentMessage> = {}): SentMessage {
  return { messageId: 'sent-1', chatId: 'chat-1', timestamp: Date.now(), ...overrides };
}

function makeMockAdapter() {
  return {
    sendMessage: vi.fn(async () => makeSentMessage()),
    addReaction: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => makeSentMessage()),
    editMessage: vi.fn(async () => undefined),
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
  return Object.assign(em, {
    createInstance: vi.fn(async () => ({ id: 'inst-1' })),
    sendInput: vi.fn(async () => undefined),
    getInstances: vi.fn(() => [] as { id: string; status: string }[]),
  });
}

function makeMockChannelManager(adapter: ReturnType<typeof makeMockAdapter>) {
  const listeners = new Set<(event: ChannelEvent) => void>();
  return {
    getAdapter: vi.fn(() => adapter),
    onEvent: vi.fn((cb: (event: ChannelEvent) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    // helper for tests to emit events
    _emit: (event: ChannelEvent) => {
      for (const l of listeners) l(event);
    },
  } as unknown as ChannelManager & { _emit: (event: ChannelEvent) => void };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelMessageRouter', () => {
  let adapter: ReturnType<typeof makeMockAdapter>;
  let persistence: ReturnType<typeof makeMockPersistence>;
  let channelManager: ReturnType<typeof makeMockChannelManager>;
  let instanceManager: ReturnType<typeof makeMockInstanceManager>;
  let router: ChannelMessageRouter;

  beforeEach(() => {
    adapter = makeMockAdapter();
    persistence = makeMockPersistence();
    channelManager = makeMockChannelManager(adapter);
    instanceManager = makeMockInstanceManager();
    router = new ChannelMessageRouter(
      channelManager as unknown as ChannelManager,
      persistence as unknown as ChannelPersistence,
    );
    router._setInstanceManagerForTesting(instanceManager);
  });

  afterEach(() => {
    router.stop();
    vi.useRealTimers();
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

  // -------------------------------------------------------------------------
  // Output debounce / streaming
  // -------------------------------------------------------------------------

  describe('output debounce', () => {
    it('batches output for 2 seconds before sending back to channel', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-1', chatId: 'c1', messageId: 'dm1' }));

      // Emit two output chunks from the created instance
      instanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'Hello ' },
      });
      instanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'World' },
      });

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

      instanceManager.emit('instance:output', {
        instanceId: 'inst-1',
        message: { type: 'text', content: 'Response text' },
      });

      await vi.advanceTimersByTimeAsync(2000);

      expect(persistence.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'outbound',
          content: 'Response text',
          instance_id: 'inst-1',
          reply_to_message_id: 'dm1',
        })
      );
    });

    it('ignores output from other instances', async () => {
      vi.useFakeTimers();

      await router.handleInboundMessage(makeMessage({ id: 'deb-3' }));

      instanceManager.emit('instance:output', {
        instanceId: 'other-inst',
        message: { type: 'text', content: 'Not mine' },
      });

      await vi.advanceTimersByTimeAsync(2000);

      // sendMessage was called for eyes/check reactions only (addReaction), not sendMessage
      expect(adapter.sendMessage).not.toHaveBeenCalled();
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
