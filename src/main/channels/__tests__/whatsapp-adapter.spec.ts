import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';

// ---------- Hoisted mock helpers ----------

const { mockExistsSync } = vi.hoisted(() => {
  return { mockExistsSync: vi.fn<[string], boolean>(() => false) };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mockExistsSync };
});

// ---------- Mock whatsapp-web.js BEFORE importing the adapter ----------

let mockClientInstance: MockWAClient;
let triggerQR: (qr: string) => void;
let triggerReady: () => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let triggerMessage: (msg: any) => void;
let triggerAuthFailure: (msg: string) => void;
let triggerDisconnected: (reason: string) => void;

class MockWAClient extends EventEmitter {
  info: { wid: { user: string } } | null = null;
  initialize = vi.fn(async () => {
    // Simulate ready after initialize
  });
  destroy = vi.fn(async () => undefined);
  sendMessage = vi.fn(async () => ({
    id: { _serialized: 'sent-msg-id' },
    timestamp: 1000,
  }));
  getChatById = vi.fn(async () => ({
    fetchMessages: vi.fn(async () => []),
  }));

  override on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'qr') triggerQR = listener as (qr: string) => void;
    if (event === 'ready') triggerReady = listener as () => void;
    if (event === 'message') triggerMessage = listener;
    if (event === 'auth_failure') triggerAuthFailure = listener as (msg: string) => void;
    if (event === 'disconnected') triggerDisconnected = listener as (reason: string) => void;
    return super.on(event, listener);
  }
}

vi.mock('whatsapp-web.js', () => {
  return {
    Client: vi.fn().mockImplementation(() => {
      mockClientInstance = new MockWAClient();
      return mockClientInstance;
    }),
    LocalAuth: vi.fn().mockImplementation(() => ({ strategy: 'local' })),
    MessageMedia: {
      fromFilePath: vi.fn().mockReturnValue({ data: 'mock-media', mimetype: 'image/png', filename: 'test.png' }),
    },
  };
});

vi.mock('puppeteer-core', () => ({
  default: {},
  executablePath: vi.fn().mockReturnValue('/mock/chrome'),
}));

// Mock electron to throw so the adapter uses the fallback data path
vi.mock('electron', () => {
  throw new Error('electron not available in tests');
});

// ---------- Set PUPPETEER_EXECUTABLE_PATH so findChromePath() returns a value ----------

const ORIGINAL_ENV = process.env['PUPPETEER_EXECUTABLE_PATH'];

// Import AFTER vi.mock
import { WhatsAppAdapter } from '../adapters/whatsapp-adapter';
import type { ChannelStatusEvent, ChannelConfig, InboundChannelMessage, ChannelErrorEvent } from '../../../shared/types/channels';

// ---------- helpers ----------

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    platform: 'whatsapp',
    allowedSenders: [],
    allowedChats: [],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeWAMessage(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    fromMe: false,
    from: 'sender-1@c.us',
    author: undefined,
    body: 'Hello from WhatsApp',
    id: { _serialized: 'wa-msg-1' },
    hasQuotedMsg: false,
    hasMedia: false,
    type: 'chat',
    timestamp: 1700000000,
    _data: {},
    getContact: vi.fn(async () => ({ pushname: 'Alice', name: 'Alice', id: { user: 'sender-1' } })),
    getChat: vi.fn(async () => ({
      isGroup: false,
      id: { _serialized: 'sender-1@c.us' },
    })),
    getMentions: vi.fn(async () => []),
    reply: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ---------- tests ----------

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    process.env['PUPPETEER_EXECUTABLE_PATH'] = '/mock/chrome';
    adapter = new WhatsAppAdapter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env['PUPPETEER_EXECUTABLE_PATH'];
    } else {
      process.env['PUPPETEER_EXECUTABLE_PATH'] = ORIGINAL_ENV;
    }
  });

  // ---- initial state ----

  it('starts in disconnected status', () => {
    expect(adapter.status).toBe('disconnected');
  });

  it('has platform whatsapp', () => {
    expect(adapter.platform).toBe('whatsapp');
  });

  it('defaults to pairing mode', () => {
    const policy = adapter.getAccessPolicy();
    expect(policy.mode).toBe('pairing');
    expect(policy.maxPending).toBe(3);
    expect(policy.allowedSenders).toEqual([]);
  });

  // ---- connect: QR + ready flow ----

  it('emits connecting status on connect', async () => {
    const statuses: string[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    // Start connect but don't await — we'll fire events manually
    const connectPromise = adapter.connect(makeConfig());

    // Allow connect to proceed through initialize
    await connectPromise;

    expect(statuses).toContain('connecting');
  });

  it('emits qr event when QR code is received', async () => {
    const qrCodes: string[] = [];
    adapter.on('qr', (qr: string) => qrCodes.push(qr));

    await adapter.connect(makeConfig());

    // Simulate QR event from WhatsApp client
    triggerQR('mock-qr-data');

    expect(qrCodes).toEqual(['mock-qr-data']);
  });

  it('emits connected status after ready event', async () => {
    const statuses: string[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await adapter.connect(makeConfig());

    // Simulate client becoming ready
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    expect(statuses).toContain('connected');
    expect(adapter.status).toBe('connected');
  });

  it('includes phoneNumber in connected status event', async () => {
    const statusEvents: ChannelStatusEvent[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statusEvents.push(e));

    await adapter.connect(makeConfig());

    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    const connectedEvent = statusEvents.find(e => e.status === 'connected');
    expect(connectedEvent?.phoneNumber).toBe('15551234567');
  });

  it('emits error event when Chrome is not found', async () => {
    delete process.env['PUPPETEER_EXECUTABLE_PATH'];
    // mockExistsSync defaults to returning false (set in beforeEach via vi.clearAllMocks)
    // No real Chrome path will be found

    const errors: ChannelErrorEvent[] = [];
    const statuses: string[] = [];
    adapter.on('error', (e: ChannelErrorEvent) => errors.push(e));
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await adapter.connect(makeConfig());

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/Chrome\/Chromium not found/);
    expect(errors[0].recoverable).toBe(false);
    expect(statuses).toContain('disconnected');
    expect(adapter.status).toBe('disconnected');
  });

  it('emits error status on auth_failure', async () => {
    const errors: ChannelErrorEvent[] = [];
    const statuses: string[] = [];
    adapter.on('error', (e: ChannelErrorEvent) => errors.push(e));
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await adapter.connect(makeConfig());

    triggerAuthFailure('Session expired');

    expect(statuses).toContain('error');
    expect(errors.some(e => e.error.includes('Session expired'))).toBe(true);
  });

  it('emits disconnected status on client disconnect', async () => {
    const statuses: string[] = [];
    adapter.on('status', (e: ChannelStatusEvent) => statuses.push(e.status));

    await adapter.connect(makeConfig());
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    triggerDisconnected('LOGOUT');

    expect(adapter.status).toBe('disconnected');
    expect(statuses).toContain('disconnected');
  });

  // ---- disconnect ----

  it('disconnects cleanly', async () => {
    await adapter.connect(makeConfig());
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

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

  // ---- inbound message handling ----

  it('emits message event for allowlisted sender in DM', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['sender-1@c.us'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeWAMessage();
    await triggerMessage(msg);
    // wait for async handler
    await new Promise(r => setTimeout(r, 0));

    expect(messages).toHaveLength(1);
    expect(messages[0].senderId).toBe('sender-1@c.us');
    expect(messages[0].content).toBe('Hello from WhatsApp');
    expect(messages[0].platform).toBe('whatsapp');
    expect(messages[0].isDM).toBe(true);
    expect(messages[0].isGroup).toBe(false);
  });

  it('drops messages from self (fromMe=true)', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['sender-1@c.us'] }));

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeWAMessage({ fromMe: true });
    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    expect(messages).toHaveLength(0);
  });

  it('drops messages from non-allowlisted senders silently', async () => {
    await adapter.connect(makeConfig());
    adapter.setAccessPolicy({
      mode: 'allowlist',
      allowedSenders: ['other-user@c.us'],
      pendingPairings: [],
      maxPending: 3,
      codeExpiryMs: 300_000,
    });

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeWAMessage();
    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    expect(messages).toHaveLength(0);
  });

  it('sends pairing code reply to unknown sender in pairing mode', async () => {
    await adapter.connect(makeConfig());

    const replyFn = vi.fn(async () => undefined);
    const msg = makeWAMessage({
      from: 'new-user@c.us',
      reply: replyFn,
      getContact: vi.fn(async () => ({ pushname: 'Newbie', name: 'Newbie', id: { user: 'new-user' } })),
    });

    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    expect(replyFn).toHaveBeenCalledOnce();
    const replyArg: string = replyFn.mock.calls[0][0] as string;
    expect(replyArg).toMatch(/pairing code/i);
    expect(replyArg).toMatch(/[0-9A-F]{6}/);
  });

  it('ignores group messages that do not mention bot', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['sender-1@c.us'] }));
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeWAMessage({
      body: 'Hello everyone',
      getChat: vi.fn(async () => ({
        isGroup: true,
        id: { _serialized: 'group-1@g.us' },
      })),
      getMentions: vi.fn(async () => []),
    });

    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    expect(messages).toHaveLength(0);
  });

  it('processes group messages that mention the bot by number', async () => {
    await adapter.connect(makeConfig({ allowedSenders: ['sender-1@c.us'] }));
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    const messages: InboundChannelMessage[] = [];
    adapter.on('message', (msg: InboundChannelMessage) => messages.push(msg));

    const msg = makeWAMessage({
      body: '@15551234567 hello bot',
      getChat: vi.fn(async () => ({
        isGroup: true,
        id: { _serialized: 'group-1@g.us' },
      })),
      getMentions: vi.fn(async () => [{ id: { user: '15551234567' } }]),
    });

    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    expect(messages).toHaveLength(1);
    expect(messages[0].isGroup).toBe(true);
    expect(messages[0].isDM).toBe(false);
  });

  // ---- editMessage not supported ----

  it('editMessage throws "not supported"', async () => {
    await expect(
      adapter.editMessage('chat-id', 'msg-id', 'new content')
    ).rejects.toThrow('WhatsApp does not support editing messages');
  });

  // ---- sendMessage (basic) ----

  it('throws when sendMessage called without connected client', async () => {
    await expect(
      adapter.sendMessage('chat-id', 'hello')
    ).rejects.toThrow('WhatsApp client not connected');
  });

  it('sendMessage delegates to client.sendMessage', async () => {
    await adapter.connect(makeConfig());
    mockClientInstance.info = { wid: { user: '15551234567' } };
    triggerReady();

    const result = await adapter.sendMessage('chat-1@c.us', 'Hello');

    expect(mockClientInstance.sendMessage).toHaveBeenCalledWith('chat-1@c.us', 'Hello');
    expect(result.chatId).toBe('chat-1@c.us');
    expect(result.messageId).toBe('sent-msg-id');
  });

  // ---- access policy ----

  it('pairSender succeeds with valid code', async () => {
    await adapter.connect(makeConfig());

    const replyFn = vi.fn(async () => undefined);
    const msg = makeWAMessage({
      from: 'new-user@c.us',
      reply: replyFn,
      getContact: vi.fn(async () => ({ pushname: 'Newbie', name: 'Newbie', id: { user: 'new-user' } })),
    });

    await triggerMessage(msg);
    await new Promise(r => setTimeout(r, 0));

    const replyText: string = replyFn.mock.calls[0][0] as string;
    const match = replyText.match(/\*([0-9A-F]{6})\*/);
    expect(match).toBeTruthy();
    const code = match![1];

    const paired = await adapter.pairSender(code);
    expect(paired.senderId).toBe('new-user@c.us');
    expect(paired.platform).toBe('whatsapp');
    expect(adapter.getAccessPolicy().allowedSenders).toContain('new-user@c.us');
  });

  it('pairSender throws for invalid code', async () => {
    await expect(adapter.pairSender('ZZZZZZ')).rejects.toThrow('Invalid or expired pairing code');
  });
});
