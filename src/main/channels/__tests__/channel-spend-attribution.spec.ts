import { describe, expect, it, vi } from 'vitest';
import { ChannelMessageRouter } from '../channel-message-router';
import type { ChannelManager } from '../channel-manager';
import type { ChannelPersistence } from '../channel-persistence';
import type { BaseChannelAdapter } from '../channel-adapter';
import type { InboundChannelMessage } from '../../../shared/types/channels';
import { recordInstanceTurnAttribution, subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';

vi.mock('../../remote-node', () => ({ getWorkerNodeRegistry: () => ({ getAllNodes: () => [] }) }));
vi.mock('../../remote-node/remote-node-config', () => ({ getRemoteNodeConfig: () => ({ autoOffloadBrowser: false, autoOffloadAndroid: false }) }));
vi.mock('../../core/config/recent-directories-manager', () => ({ getRecentDirectoriesManager: () => ({ addDirectory: vi.fn() }) }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: vi.fn(), getAll: () => ({}) }) }));

describe('channel spend attribution', () => {
  it('tags a newly created channel session before its first turn', async () => {
    let metadata: Record<string, unknown> | undefined;
    const manager = { createInstance: vi.fn(async (input: { metadata?: Record<string, unknown> }) => {
      metadata = input.metadata;
      return { id: 'channel-instance' };
    }) };
    const router = new ChannelMessageRouter({} as ChannelManager, {} as ChannelPersistence, null);
    router.setInstanceManager(manager);
    const message: InboundChannelMessage = { id: 'msg-example', platform: 'discord', chatId: 'chat-example', messageId: 'message-example', senderId: 'sender-example', senderName: 'Example', content: '', attachments: [], isGroup: false, isDM: true, timestamp: 1000 };
    const records: CostAttributionRecord[] = [];
    const stop = subscribeCostAttribution(record => records.push(record));
    try {
      await (router as unknown as { routeDefault: (msg: InboundChannelMessage, content: string, adapter: BaseChannelAdapter, cwd: string) => Promise<string> }).routeDefault(message, '', {} as BaseChannelAdapter, '/repo');
      expect(metadata?.['spendPurpose']).toBe('channel');
      recordInstanceTurnAttribution({ instanceId: 'channel-instance', usage: { inputTokens: 10 }, costKnown: false, spendPurpose: metadata?.['spendPurpose'] as 'channel' });
      expect(records).toHaveLength(1);
      expect(records[0]?.purpose).toBe('channel');
    } finally { stop(); }
  });
});
