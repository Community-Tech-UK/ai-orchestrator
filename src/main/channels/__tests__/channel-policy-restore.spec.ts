import { describe, it, expect, vi } from 'vitest';
import { restoreSavedAccessPolicy } from '../channel-policy-restore';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  AccessPolicy,
  ChannelPlatform,
  SentMessage,
} from '../../../shared/types/channels';
import type {
  ChannelAccessPolicyStore,
  SavedAccessPolicy,
} from '../channel-access-policy-store';

class MockAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';

  connect = vi.fn(async () => undefined);
  disconnect = vi.fn(async () => undefined);
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
  editMessage = vi.fn(async () => undefined);
  addReaction = vi.fn(async () => undefined);
}

function makeStore(saved?: SavedAccessPolicy): Pick<ChannelAccessPolicyStore, 'get' | 'toAccessPolicy'> {
  return {
    get: vi.fn(() => saved),
    toAccessPolicy: vi.fn((row: SavedAccessPolicy): Pick<AccessPolicy, 'mode' | 'allowedSenders'> => ({
      mode: row.mode as AccessPolicy['mode'],
      allowedSenders: JSON.parse(row.allowed_senders_json) as string[],
    })),
  };
}

describe('restoreSavedAccessPolicy', () => {
  it('applies persisted mode and allowed senders to the adapter', () => {
    const adapter = new MockAdapter();
    const store = makeStore({
      platform: 'discord',
      mode: 'allowlist',
      allowed_senders_json: '["user-1","user-2"]',
      updated_at: 1000,
    });

    const allowedSenders = restoreSavedAccessPolicy(
      adapter,
      'discord',
      store as ChannelAccessPolicyStore,
    );

    expect(allowedSenders).toEqual(['user-1', 'user-2']);
    expect(adapter.getAccessPolicy()).toEqual(
      expect.objectContaining({
        mode: 'allowlist',
        allowedSenders: ['user-1', 'user-2'],
      }),
    );
  });

  it('returns the current in-memory allowlist when no persisted policy exists', () => {
    const adapter = new MockAdapter();
    adapter.setAccessPolicy({
      ...adapter.getAccessPolicy(),
      allowedSenders: ['already-paired'],
    });

    const allowedSenders = restoreSavedAccessPolicy(
      adapter,
      'discord',
      makeStore() as ChannelAccessPolicyStore,
    );

    expect(allowedSenders).toEqual(['already-paired']);
    expect(adapter.getAccessPolicy()).toEqual(
      expect.objectContaining({
        mode: 'pairing',
        allowedSenders: ['already-paired'],
      }),
    );
  });
});
