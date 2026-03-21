import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock discord.js before import
const mockLogin = vi.fn();
const mockDestroy = vi.fn();
const mockChannelSend = vi.fn().mockResolvedValue({ id: 'sent-1' });

vi.mock('discord.js', () => {
  const EventEmitter = require('events');
  class MockClient extends EventEmitter {
    user = { id: 'bot-123', tag: 'TestBot#0001' };
    ws = { ping: 50 };
    login = mockLogin;
    destroy = mockDestroy;
    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: mockChannelSend,
        isTextBased: () => true,
      }),
    };
  }
  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: { Channel: 0, Message: 1 },
  };
});

import { DiscordAdapter } from '../adapters/discord-adapter';

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter();
  });

  afterEach(async () => {
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  it('should start as disconnected', () => {
    expect(adapter.platform).toBe('discord');
    expect(adapter.status).toBe('disconnected');
  });

  it('should connect with a bot token', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });
    expect(mockLogin).toHaveBeenCalledWith('test-token');
    expect(adapter.status).toBe('connected');
  });

  it('should reject connect without token', async () => {
    await expect(
      adapter.connect({ platform: 'discord', allowedSenders: [], allowedChats: [] })
    ).rejects.toThrow();
  });

  it('should disconnect', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });
    await adapter.disconnect();
    expect(adapter.status).toBe('disconnected');
  });

  it('should chunk messages longer than 2000 chars', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });

    const longMessage = 'x'.repeat(4500);
    await adapter.sendMessage('chat-1', longMessage);

    // Should have sent 3 chunks (2000 + 2000 + 500)
    expect(mockChannelSend).toHaveBeenCalledTimes(3);
  });

  it('should manage access policy', () => {
    const policy = adapter.getAccessPolicy();
    expect(policy.mode).toBe('pairing');

    adapter.setAccessPolicy({ ...policy, mode: 'allowlist' });
    expect(adapter.getAccessPolicy().mode).toBe('allowlist');
  });
});
