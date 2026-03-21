import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelManager } from '../channel-manager';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  ChannelPlatform, ChannelConnectionStatus, ChannelConfig,
  ChannelSendOptions, ChannelSentMessage, AccessPolicy, PairedSender,
} from '../../../shared/types/channels';

class MockAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  status: ChannelConnectionStatus = 'disconnected';

  connect = vi.fn(async () => { this.status = 'connected'; });
  disconnect = vi.fn(async () => { this.status = 'disconnected'; });
  sendMessage = vi.fn(async (): Promise<ChannelSentMessage> => ({ messageId: '1', chatId: 'c', timestamp: Date.now() }));
  sendFile = vi.fn(async (): Promise<ChannelSentMessage> => ({ messageId: '1', chatId: 'c', timestamp: Date.now() }));
  editMessage = vi.fn(async () => {});
  addReaction = vi.fn(async () => {});
  getAccessPolicy = vi.fn((): AccessPolicy => ({ mode: 'disabled', allowedSenders: [], pendingPairings: [], maxPending: 3, codeExpiryMs: 3600000 }));
  setAccessPolicy = vi.fn();
  pairSender = vi.fn(async (): Promise<PairedSender> => ({ senderId: 's', senderName: 'n', platform: 'discord', pairedAt: Date.now() }));
}

describe('ChannelManager', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    ChannelManager._resetForTesting();
    manager = ChannelManager.getInstance();
  });

  it('should be a singleton', () => {
    expect(ChannelManager.getInstance()).toBe(manager);
  });

  it('should register and retrieve adapters', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    expect(manager.getAdapter('discord')).toBe(adapter);
  });

  it('should unregister adapters', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    manager.unregisterAdapter('discord');
    expect(manager.getAdapter('discord')).toBeUndefined();
  });

  it('should return all statuses', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    const statuses = manager.getAllStatuses();
    expect(statuses.get('discord')).toBe('disconnected');
  });

  it('should call disconnect on all adapters during shutdown', async () => {
    const adapter = new MockAdapter();
    adapter.status = 'connected';
    manager.registerAdapter(adapter);
    await manager.shutdown();
    expect(adapter.disconnect).toHaveBeenCalled();
  });

  it('should not fail shutdown if adapter disconnect throws', async () => {
    const adapter = new MockAdapter();
    adapter.status = 'connected';
    adapter.disconnect = vi.fn(async () => { throw new Error('fail'); });
    manager.registerAdapter(adapter);
    await expect(manager.shutdown()).resolves.not.toThrow();
  });
});
