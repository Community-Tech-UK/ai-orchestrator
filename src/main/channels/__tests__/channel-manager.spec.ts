import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelManager, getChannelManager } from '../channel-manager';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  ChannelPlatform,
  SentMessage,
  InboundChannelMessage,
  ChannelStatusEvent,
  ChannelErrorEvent,
  ChannelResponse,
} from '../../../shared/types/channels';

// ---------------------------------------------------------------------------
// Mock logger so tests don't write to disk / console
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
// Minimal concrete adapter for testing
// ---------------------------------------------------------------------------

class MockAdapter extends BaseChannelAdapter {
  constructor(public readonly platform: ChannelPlatform) {
    super();
  }

  connect = vi.fn(async (): Promise<void> => {
    this._status = 'connected';
  });

  disconnect = vi.fn(async (): Promise<void> => {
    this._status = 'disconnected';
  });

  sendMessage = vi.fn(async (chatId: string): Promise<SentMessage> => ({
    messageId: 'msg-1',
    chatId,
    timestamp: Date.now(),
  }));

  sendFile = vi.fn(async (chatId: string): Promise<SentMessage> => ({
    messageId: 'file-1',
    chatId,
    timestamp: Date.now(),
  }));

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  editMessage = vi.fn(async (): Promise<void> => {});

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  addReaction = vi.fn(async (): Promise<void> => {});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInboundMessage(platform: ChannelPlatform): InboundChannelMessage {
  return {
    id: 'inbound-1',
    platform,
    chatId: 'chat-1',
    messageId: 'msg-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'Hello',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: Date.now(),
  };
}

function makeStatusEvent(platform: ChannelPlatform): ChannelStatusEvent {
  return { platform, status: 'connected' };
}

function makeErrorEvent(platform: ChannelPlatform): ChannelErrorEvent {
  return { platform, error: 'test error', recoverable: true };
}

function makeResponseEvent(platform: ChannelPlatform): ChannelResponse {
  return {
    channelMessageId: 'channel-msg-1',
    platform,
    chatId: 'chat-1',
    messageId: 'response-msg-1',
    instanceId: 'instance-1',
    content: 'Done.',
    status: 'complete',
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelManager', () => {
  beforeEach(() => {
    ChannelManager._resetForTesting();
  });

  it('is a singleton — getInstance() always returns the same reference', () => {
    const a = ChannelManager.getInstance();
    const b = ChannelManager.getInstance();
    expect(a).toBe(b);
  });

  it('getChannelManager() helper returns the singleton', () => {
    const manager = ChannelManager.getInstance();
    expect(getChannelManager()).toBe(manager);
  });

  describe('registerAdapter / getAdapter', () => {
    it('registers and retrieves an adapter by platform', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');

      manager.registerAdapter(adapter);

      expect(manager.getAdapter('discord')).toBe(adapter);
    });

    it('returns undefined for unregistered platform', () => {
      const manager = ChannelManager.getInstance();
      expect(manager.getAdapter('whatsapp')).toBeUndefined();
    });

    it('replaces existing adapter and removes its listeners', () => {
      const manager = ChannelManager.getInstance();
      const first = new MockAdapter('discord');
      const removeAllListenersSpy = vi.spyOn(first, 'removeAllListeners');

      manager.registerAdapter(first);

      const second = new MockAdapter('discord');
      manager.registerAdapter(second);

      expect(removeAllListenersSpy).toHaveBeenCalled();
      expect(manager.getAdapter('discord')).toBe(second);
    });
  });

  describe('unregisterAdapter', () => {
    it('removes a registered adapter', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      manager.unregisterAdapter('discord');

      expect(manager.getAdapter('discord')).toBeUndefined();
    });

    it('removes all listeners from the adapter on unregister', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);
      const removeAllListenersSpy = vi.spyOn(adapter, 'removeAllListeners');

      manager.unregisterAdapter('discord');

      expect(removeAllListenersSpy).toHaveBeenCalled();
    });

    it('is a no-op when the platform is not registered', () => {
      const manager = ChannelManager.getInstance();
      // Should not throw
      expect(() => manager.unregisterAdapter('whatsapp')).not.toThrow();
    });
  });

  describe('getStatuses', () => {
    it('returns "unregistered" for platforms with no adapter', () => {
      const statuses = ChannelManager.getInstance().getStatuses();
      expect(statuses.discord).toBe('unregistered');
      expect(statuses.whatsapp).toBe('unregistered');
    });

    it('returns the adapter status for registered platforms', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      adapter._status = 'connected';
      manager.registerAdapter(adapter);

      const statuses = manager.getStatuses();
      expect(statuses.discord).toBe('connected');
      expect(statuses.whatsapp).toBe('unregistered');
    });
  });

  describe('shutdown', () => {
    it('calls disconnect on connected adapters', async () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      adapter._status = 'connected';
      manager.registerAdapter(adapter);

      await manager.shutdown();

      expect(adapter.disconnect).toHaveBeenCalled();
    });

    it('calls disconnect on connecting adapters', async () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('whatsapp');
      adapter._status = 'connecting';
      manager.registerAdapter(adapter);

      await manager.shutdown();

      expect(adapter.disconnect).toHaveBeenCalled();
    });

    it('does not call disconnect on disconnected adapters', async () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      adapter._status = 'disconnected';
      manager.registerAdapter(adapter);

      await manager.shutdown();

      expect(adapter.disconnect).not.toHaveBeenCalled();
    });

    it('handles disconnect errors without throwing', async () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      adapter._status = 'connected';
      adapter.disconnect.mockRejectedValueOnce(new Error('network gone'));
      manager.registerAdapter(adapter);

      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('onEvent / event forwarding', () => {
    it('forwards message events from adapter to listeners', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const listener = vi.fn();
      manager.onEvent(listener);

      const msg = makeInboundMessage('discord');
      adapter.emit('message', msg);

      expect(listener).toHaveBeenCalledWith({ type: 'message', data: msg });
    });

    it('forwards status events from adapter to listeners', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const listener = vi.fn();
      manager.onEvent(listener);

      const evt = makeStatusEvent('discord');
      adapter.emit('status', evt);

      expect(listener).toHaveBeenCalledWith({ type: 'status', data: evt });
    });

    it('forwards error events from adapter to listeners', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const listener = vi.fn();
      manager.onEvent(listener);

      const evt = makeErrorEvent('discord');
      adapter.emit('error', evt);

      expect(listener).toHaveBeenCalledWith({ type: 'error', data: evt });
    });

    it('forwards qr events from adapter to listeners', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('whatsapp');
      manager.registerAdapter(adapter);

      const listener = vi.fn();
      manager.onEvent(listener);

      adapter.emit('qr', 'qr-data-string');

      expect(listener).toHaveBeenCalledWith({ type: 'qr', data: 'qr-data-string' });
      expect(listener).toHaveBeenCalledWith({
        type: 'status',
        data: {
          platform: 'whatsapp',
          status: 'connecting',
          qrCode: 'qr-data-string',
        },
      });
    });

    it('forwards response-sent events to listeners', () => {
      const manager = ChannelManager.getInstance();
      const listener = vi.fn();
      manager.onEvent(listener);

      const response = makeResponseEvent('discord');
      manager.emitResponseSent(response);

      expect(listener).toHaveBeenCalledWith({ type: 'response-sent', data: response });
    });

    it('onEvent returns a cleanup function that removes the listener', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const listener = vi.fn();
      const unsubscribe = manager.onEvent(listener);

      unsubscribe();

      const msg = makeInboundMessage('discord');
      adapter.emit('message', msg);

      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies multiple listeners for the same event', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const listenerA = vi.fn();
      const listenerB = vi.fn();
      manager.onEvent(listenerA);
      manager.onEvent(listenerB);

      const msg = makeInboundMessage('discord');
      adapter.emit('message', msg);

      expect(listenerA).toHaveBeenCalledOnce();
      expect(listenerB).toHaveBeenCalledOnce();
    });

    it('continues notifying other listeners when one throws', () => {
      const manager = ChannelManager.getInstance();
      const adapter = new MockAdapter('discord');
      manager.registerAdapter(adapter);

      const throwing = vi.fn().mockImplementation(() => { throw new Error('oops'); });
      const safe = vi.fn();
      manager.onEvent(throwing);
      manager.onEvent(safe);

      const msg = makeInboundMessage('discord');
      adapter.emit('message', msg);

      expect(safe).toHaveBeenCalled();
    });
  });
});
