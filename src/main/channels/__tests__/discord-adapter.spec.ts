import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import { EventEmitter } from 'events';

// ---------- Mock discord.js BEFORE importing the adapter ----------

let capturedMessageHandler: ((msg: unknown) => void) | null = null;

class MockClient extends EventEmitter {
  user: { id: string; tag: string } | null = null;
  channels = {
    fetch: vi.fn(),
  };

  override on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'messageCreate') {
      capturedMessageHandler = listener;
    }
    return super.on(event, listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  login = vi.fn(async (_token: string) => {
    this.user = { id: 'bot-123', tag: 'TestBot#0001' };
  });

  destroy = vi.fn();
}

let mockClientInstance: MockClient;

vi.mock('discord.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => {
      mockClientInstance = new MockClient();
      return mockClientInstance;
    }),
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: {
      Channel: 0,
    },
  };
});

// Import AFTER vi.mock
import { DiscordAdapter } from '../adapters/discord-adapter';
import type { ChannelStatusEvent, ChannelConfig, InboundChannelMessage } from '../../../shared/types/channels';

// ---------- helpers ----------

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    platform: 'discord',
    token: 'test-token',
    allowedSenders: [],
    allowedChats: [],
    ...overrides,
  };
}

interface MockMessage {
  id: string;
  content: string;
  channelId: string;
  guild: object | null;
  author: { id: string; username: string; tag: string; bot: boolean };
  mentions: { has: (id: string) => boolean };
  attachments: { values: () => unknown[] };
  reference: { messageId: string } | null;
  thread: { id: string } | null;
  createdTimestamp: number;
  channel: { sendTyping: () => Promise<void> };
  reply: (msg: string) => Promise<{ id: string; createdTimestamp: number }>;
}

function makeMessage(overrides: Partial<MockMessage> = {}): MockMessage {
  return {
    id: 'msg-1',
    content: 'Hello bot',
    channelId: 'chan-1',
    guild: null,
    author: { id: 'user-1', username: 'alice', tag: 'alice#1234', bot: false },
    mentions: { has: () => false },
    attachments: { values: () => [] },
    reference: null,
    thread: null,
    createdTimestamp: 1000,
    channel: { sendTyping: vi.fn().mockResolvedValue(undefined) },
    reply: vi.fn().mockResolvedValue({ id: 'reply-1', createdTimestamp: 2000 }),
    ...overrides,
  };
}

// ---------- tests ----------

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    capturedMessageHandler = null;
    adapter = new DiscordAdapter();
    vi.clearAllMocks();
  });

  // ---- initial state ----

  it('starts in disconnected status', () => {
    expect(adapter.status).toBe('disconnected');
  });

  it('has platform discord', () => {
    expect(adapter.platform).toBe('discord');
  });

  it('defaults to pairing mode with maxPending=3', () => {
    const policy = adapter.getAccessPolicy();
    expect(policy.mode).toBe('pairing');
    expect(policy.maxPending).toBe(3);
    expect(policy.allowedSenders).toEqual([]);
  });

  // ---- connect / disconnect ----

  it('emits connecting then connected status events on successful connect', async () => {
    const statusEvents: string[] = [];
    adapter.on('status', (event: ChannelStatusEvent) => statusEvents.push(event.status));

    await adapter.connect(makeConfig());

    expect(statusEvents).toEqual(['connecting', 'connected']);
    expect(adapter.status).toBe('connected');
  });

  it('includes botUsername in connected event', async () => {
    const statusEvents: { status: string; botUsername?: string }[] = [];
    adapter.on('status', (event: ChannelStatusEvent) =>
      statusEvents.push({ status: event.status, botUsername: event.botUsername })
    );

    await adapter.connect(makeConfig());

    const connectedEvent = statusEvents.find(e => e.status === 'connected');
    expect(connectedEvent?.botUsername).toBe('TestBot#0001');
  });

  it('throws and does not emit connecting when token is missing', async () => {
    const statuses: string[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await expect(
      adapter.connect(makeConfig({ token: undefined }))
    ).rejects.toThrow('Discord bot token is required');
    expect(statuses).not.toContain('connecting');
    expect(adapter.status).toBe('disconnected');
  });

  it('emits error event and rethrows when login fails', async () => {
    const errors: string[] = [];
    const statuses: string[] = [];

    const failAdapter = new DiscordAdapter();
    failAdapter.on('error', (e: { error: string }) => errors.push(e.error));
    failAdapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    const ClientMock = (await import('discord.js')).Client as MockInstance;
    ClientMock.mockImplementationOnce(() => {
      const c = new MockClient();
      c.login = vi.fn().mockRejectedValue(new Error('Invalid token'));
      return c;
    });

    await expect(failAdapter.connect(makeConfig())).rejects.toThrow('Invalid token');
    expect(statuses).toContain('error');
    expect(errors.some(e => e.includes('Invalid token'))).toBe(true);
  });

  it('disconnects cleanly', async () => {
    await adapter.connect(makeConfig());

    const statuses: string[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await adapter.disconnect();

    expect(adapter.status).toBe('disconnected');
    expect(statuses).toContain('disconnected');
    expect(mockClientInstance.destroy).toHaveBeenCalled();
  });

  it('disconnect is a no-op when not connected', async () => {
    await expect(adapter.disconnect()).resolves.not.toThrow();
    expect(adapter.status).toBe('disconnected');
  });

  // ---- message chunking ----

  it('chunks a short message as a single chunk', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = (adapter as any).chunkMessage('Hello world', 2000);
    expect(result).toEqual(['Hello world']);
  });

  it('chunks a message longer than 2000 chars', () => {
    const long = 'a'.repeat(2500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string[] = (adapter as any).chunkMessage(long, 2000);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join('')).toBe(long);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it('splits at paragraph boundaries when available', () => {
    const para1 = 'a'.repeat(1000);
    const para2 = 'b'.repeat(1000);
    const content = `${para1}\n\n${para2}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string[] = (adapter as any).chunkMessage(content, 2000);
    // Content is 2002 chars total (1000 + 2 + 1000), so it must split
    expect(result.length).toBeGreaterThan(1);
  });

  // ---- inbound message handling ----

  it('emits message event for allowed sender in DM', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['user-1'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeMessage({ guild: null });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(1);
    expect(messages[0].senderId).toBe('user-1');
    expect(messages[0].content).toBe('Hello bot');
    expect(messages[0].platform).toBe('discord');
    expect(messages[0].isDM).toBe(true);
    expect(messages[0].isGroup).toBe(false);
  });

  it('drops messages from non-allowlisted senders silently (no message event)', async () => {
    await adapter.connect(makeConfig());
    // Put adapter in allowlist mode so pairing is not triggered
    adapter.setAccessPolicy({
      mode: 'allowlist',
      allowedSenders: ['other-user'],
      pendingPairings: [],
      maxPending: 3,
      codeExpiryMs: 300_000,
    });

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeMessage({
      guild: null,
      author: { id: 'unknown-user', username: 'stranger', tag: 'stranger#0000', bot: false },
    });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(0);
  });

  it('sends pairing code reply to unknown sender in pairing mode', async () => {
    await adapter.connect(makeConfig());
    // accessPolicy is pairing mode by default

    const replyFn = vi.fn().mockResolvedValue({ id: 'reply-1', createdTimestamp: 2000 });
    const msg = makeMessage({
      guild: null,
      author: { id: 'new-user', username: 'newbie', tag: 'newbie#0000', bot: false },
      reply: replyFn,
    });

    await capturedMessageHandler!(msg);

    expect(replyFn).toHaveBeenCalledOnce();
    const replyArg: string = replyFn.mock.calls[0][0] as string;
    expect(replyArg).toMatch(/pairing code/i);
    expect(replyArg).toMatch(/[0-9A-F]{6}/);
  });

  it('ignores messages from the bot itself', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['bot-123'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeMessage({
      guild: null,
      author: { id: 'bot-123', username: 'TestBot', tag: 'TestBot#0001', bot: false },
    });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(0);
  });

  it('ignores messages from other bots', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['other-bot'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeMessage({
      guild: null,
      author: { id: 'other-bot', username: 'OtherBot', tag: 'OtherBot#0000', bot: true },
    });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(0);
  });

  it('ignores group messages that do not @mention the bot', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['user-1'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const guild = { id: 'guild-1' };
    const msg = makeMessage({
      guild,
      author: { id: 'user-1', username: 'alice', tag: 'alice#1234', bot: false },
      mentions: { has: () => false }, // no bot mention
    });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(0);
  });

  it('processes group messages that @mention the bot', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['user-1'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const guild = { id: 'guild-1' };
    const msg = makeMessage({
      guild,
      content: '<@bot-123> hello',
      author: { id: 'user-1', username: 'alice', tag: 'alice#1234', bot: false },
      mentions: { has: (id: string) => id === 'bot-123' },
    });
    await capturedMessageHandler!(msg);

    expect(messages).toHaveLength(1);
    expect(messages[0].isGroup).toBe(true);
    expect(messages[0].isDM).toBe(false);
  });

  it('strips bot mention from content in group messages', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['user-1'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const guild = { id: 'guild-1' };
    const msg = makeMessage({
      guild,
      content: '<@bot-123> what is the weather?',
      author: { id: 'user-1', username: 'alice', tag: 'alice#1234', bot: false },
      mentions: { has: (id: string) => id === 'bot-123' },
    });
    await capturedMessageHandler!(msg);

    expect(messages[0].content).toBe('what is the weather?');
  });

  // ---- access policy ----

  it('pairSender succeeds with valid code', async () => {
    await adapter.connect(makeConfig());
    // Trigger a pairing request to get a code
    const replyFn = vi.fn().mockResolvedValue({ id: 'r', createdTimestamp: 1 });
    const msg = makeMessage({
      guild: null,
      author: { id: 'new-user', username: 'newbie', tag: 'newbie#0', bot: false },
      reply: replyFn,
    });
    await capturedMessageHandler!(msg);

    // Extract the code from the reply
    const replyText: string = replyFn.mock.calls[0][0] as string;
    const match = replyText.match(/\*\*([0-9A-F]{6})\*\*/);
    expect(match).toBeTruthy();
    const code = match![1];

    const paired = await adapter.pairSender(code);
    expect(paired.senderId).toBe('new-user');
    expect(paired.platform).toBe('discord');
    expect(adapter.getAccessPolicy().allowedSenders).toContain('new-user');
  });

  it('pairSender throws for invalid code', async () => {
    await adapter.connect(makeConfig());
    await expect(adapter.pairSender('ZZZZZZ')).rejects.toThrow('Invalid or expired pairing code');
  });

  it('applies allowedSenders from config on connect', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['user-a', 'user-b'] }));
    expect(adapter.getAccessPolicy().allowedSenders).toContain('user-a');
    expect(adapter.getAccessPolicy().allowedSenders).toContain('user-b');
  });
});
