import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelMessageRouter } from '../channel-message-router';
import { ChannelPersistence } from '../channel-persistence';
import { RateLimiter } from '../rate-limiter';
import type { InboundChannelMessage, AccessPolicy } from '../../../shared/types/channels';
import type { BaseChannelAdapter } from '../channel-adapter';
import type { Instance } from '../../../shared/types/instance.types';
import type { DetectedSecret } from '../../security/secret-detector';

// Mock the security module
vi.mock('../../security/secret-detector', () => ({
  detectSecretsInContent: vi.fn().mockReturnValue([]),
  isSecretFile: vi.fn().mockReturnValue(false),
}));

// Mock the instance module
vi.mock('../../instance/instance-manager', () => ({
  getInstanceManager: vi.fn().mockReturnValue({
    createInstance: vi.fn().mockResolvedValue({ id: 'inst-1', displayName: 'Instance 1', status: 'idle' }),
    sendInput: vi.fn().mockResolvedValue(undefined),
    getAllInstances: vi.fn().mockReturnValue([
      { id: 'inst-1', displayName: 'Instance 1', status: 'idle' },
      { id: 'inst-2', displayName: 'Instance 2', status: 'idle' },
    ]),
    getInstance: vi.fn().mockReturnValue({ id: 'inst-1', displayName: 'Instance 1', status: 'idle' }),
    on: vi.fn(),
    removeListener: vi.fn(),
  }),
}));

import { detectSecretsInContent, isSecretFile } from '../../security/secret-detector';
import { getInstanceManager } from '../../instance/instance-manager';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: 'msg-1',
    platform: 'discord',
    chatId: 'chat-100',
    messageId: 'discord-msg-1',
    senderId: 'user-allowed',
    senderName: 'Alice',
    content: 'Hello',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    mode: 'allowlist',
    allowedSenders: ['user-allowed'],
    pendingPairings: [],
    maxPending: 5,
    codeExpiryMs: 60_000,
    ...overrides,
  };
}

function makeMockAdapter(policy: AccessPolicy): Partial<BaseChannelAdapter> & {
  addReaction: ReturnType<typeof vi.fn>;
  getAccessPolicy: ReturnType<typeof vi.fn>;
} {
  return {
    getAccessPolicy: vi.fn().mockReturnValue(policy),
    addReaction: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockPersistence(): Partial<ChannelPersistence> & {
  insertMessage: ReturnType<typeof vi.fn>;
  getInstanceForThread: ReturnType<typeof vi.fn>;
} {
  return {
    insertMessage: vi.fn(),
    getInstanceForThread: vi.fn().mockReturnValue(undefined),
  };
}

function makeMockRateLimiter(allows = true): Partial<RateLimiter> & {
  tryAcquire: ReturnType<typeof vi.fn>;
} {
  return {
    tryAcquire: vi.fn().mockReturnValue(allows),
  };
}

function makeRouter(
  persistenceOverrides?: Partial<ChannelPersistence>,
  rateLimiterOverrides?: Partial<RateLimiter>,
): ChannelMessageRouter {
  const persistence = { ...makeMockPersistence(), ...persistenceOverrides } as unknown as ChannelPersistence;
  const rateLimiter = { ...makeMockRateLimiter(), ...rateLimiterOverrides } as unknown as RateLimiter;
  return new ChannelMessageRouter({ persistence, rateLimiter });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ChannelMessageRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default mock implementations after clearAllMocks
    vi.mocked(detectSecretsInContent).mockReturnValue([]);
    vi.mocked(isSecretFile).mockReturnValue(false);
    const mgr = vi.mocked(getInstanceManager)();
    vi.mocked(mgr.createInstance).mockResolvedValue({ id: 'inst-1', displayName: 'Instance 1', status: 'idle' } as Instance);
    vi.mocked(mgr.sendInput).mockResolvedValue(undefined);
    vi.mocked(mgr.getAllInstances).mockReturnValue([
      { id: 'inst-1', displayName: 'Instance 1', status: 'idle' } as Instance,
      { id: 'inst-2', displayName: 'Instance 2', status: 'idle' } as Instance,
    ]);
  });

  // ── 1. Blocks unauthorized senders ───────────────────────────────────────
  it('blocks senders not in allowedSenders when mode=allowlist', async () => {
    const router = makeRouter();
    const policy = makePolicy({ mode: 'allowlist', allowedSenders: ['user-allowed'] });
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage({ senderId: 'unknown-user' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    // Should not have reached instance manager
    const mgr = vi.mocked(getInstanceManager)();
    expect(mgr.sendInput).not.toHaveBeenCalled();
    expect(mgr.createInstance).not.toHaveBeenCalled();
    // No reaction added (blocked before processing)
    expect(adapter.addReaction).not.toHaveBeenCalled();
  });

  // ── 2. Allows allowlisted senders ────────────────────────────────────────
  it('allows senders present in allowedSenders', async () => {
    const router = makeRouter();
    const policy = makePolicy({ mode: 'allowlist', allowedSenders: ['user-allowed'] });
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage({ senderId: 'user-allowed' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    // Either created an instance or sent input — either way processing occurred
    expect(mgr.sendInput).toHaveBeenCalled();
  });

  // ── 3. Blocks rate-limited senders ───────────────────────────────────────
  it('blocks rate-limited senders', async () => {
    const rateLimiter = makeMockRateLimiter(false);
    const router = makeRouter(undefined, rateLimiter as unknown as RateLimiter);
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage();

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    expect(mgr.sendInput).not.toHaveBeenCalled();
    expect(mgr.createInstance).not.toHaveBeenCalled();
  });

  // ── 4. Routes plain message to new instance ───────────────────────────────
  it('creates a new instance and sends input for plain messages', async () => {
    const persistence = makeMockPersistence();
    const router = makeRouter(persistence as unknown as ChannelPersistence);
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage({ content: 'Hello world' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    expect(mgr.createInstance).toHaveBeenCalled();
    expect(mgr.sendInput).toHaveBeenCalledWith('inst-1', 'Hello world');
  });

  // ── 5. Routes thread reply to existing instance via persistence ───────────
  it('routes a thread reply to an existing instance via persistence lookup', async () => {
    const persistence = makeMockPersistence();
    vi.mocked(persistence.getInstanceForThread!).mockReturnValue('inst-existing');
    const router = makeRouter(persistence as unknown as ChannelPersistence);
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage({ threadId: 'thread-42', content: 'Follow-up' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    expect(mgr.createInstance).not.toHaveBeenCalled();
    expect(mgr.sendInput).toHaveBeenCalledWith('inst-existing', 'Follow-up');
  });

  // ── 6. Routes @instance-NAME to specific instance ─────────────────────────
  it('routes @instance-NAME message to the named instance', async () => {
    const router = makeRouter();
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    // Use the instance ID (no spaces) as the @target — matches i.id === targetName
    const msg = makeMessage({ content: '@inst-2 Please do this task' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    expect(mgr.sendInput).toHaveBeenCalledWith('inst-2', expect.any(String));
    expect(mgr.createInstance).not.toHaveBeenCalled();
  });

  // ── 7. Routes @all to all active instances ────────────────────────────────
  it('broadcasts @all message to every active instance', async () => {
    const router = makeRouter();
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage({ content: '@all Please do this' });

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    const mgr = vi.mocked(getInstanceManager)();
    // Should have sent to both instances
    const calls = vi.mocked(mgr.sendInput).mock.calls;
    const targetIds = calls.map(c => c[0]);
    expect(targetIds).toContain('inst-1');
    expect(targetIds).toContain('inst-2');
  });

  // ── 8. assertSendable blocks content with detected secrets ────────────────
  it('assertSendable throws when content contains detected secrets', () => {
    const router = makeRouter();
    vi.mocked(detectSecretsInContent).mockReturnValue([
      { type: 'api_key', name: 'ANTHROPIC_API_KEY', value: 'sk-abc', startIndex: 0, endIndex: 10, confidence: 'high' } satisfies DetectedSecret,
    ]);

    expect(() => router.assertSendable('Here is my key: sk-abc')).toThrow(/secret/i);
  });

  // ── 9. assertSendable blocks outbound file paths matching sensitive patterns
  it('assertSendable throws when content references a sensitive file path', () => {
    const router = makeRouter();
    vi.mocked(isSecretFile).mockReturnValue(true);

    expect(() => router.assertSendable('See the file at /home/user/.env')).toThrow(/sensitive file path/i);
  });

  it('assertSendable does not throw for safe content', () => {
    const router = makeRouter();
    expect(() => router.assertSendable('This is perfectly safe content')).not.toThrow();
  });

  // ── 10. Streams results back to channel on instance output ────────────────
  it('streams instance output back to the channel after debounce', async () => {
    vi.useFakeTimers();
    const router = makeRouter();
    const policy = makePolicy();
    const adapter = { ...makeMockAdapter(policy), sendMessage: vi.fn().mockResolvedValue({ messageId: 'r1', chatId: 'chat-100', timestamp: Date.now() }) };
    const msg = makeMessage();

    const mgr = vi.mocked(getInstanceManager)();
    // Capture the 'instance:output' handler when the router subscribes
    const outputHandlers: ((data: { instanceId: string; message: { type: string; content: string } }) => void)[] = [];
    vi.mocked(mgr.on).mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === 'instance:output') outputHandlers.push(handler as typeof outputHandlers[0]);
      return mgr;
    }) as typeof mgr.on);

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    // Simulate instance output
    for (const handler of outputHandlers) {
      handler({ instanceId: 'inst-1', message: { type: 'assistant', content: 'Hello from Claude' } });
    }

    // Before debounce fires, no send
    expect(adapter.sendMessage).not.toHaveBeenCalled();

    // After debounce
    vi.advanceTimersByTime(2500);

    expect(adapter.sendMessage).toHaveBeenCalledWith('chat-100', 'Hello from Claude');

    vi.useRealTimers();
  });

  // ── 11. Adds ⏳ reaction on receipt, swaps to ✅ on success ───────────────
  it('adds ⏳ reaction on message receipt and ✅ on success', async () => {
    const router = makeRouter();
    const policy = makePolicy();
    const adapter = makeMockAdapter(policy);
    const msg = makeMessage();

    await router.handleMessage(msg, adapter as unknown as BaseChannelAdapter);

    expect(adapter.addReaction).toHaveBeenCalledWith(msg.chatId, msg.messageId, '⏳');
    expect(adapter.addReaction).toHaveBeenCalledWith(msg.chatId, msg.messageId, '✅');
  });
});
