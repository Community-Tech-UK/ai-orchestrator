import { describe, expect, it } from 'vitest';
import { NativeConversationRegistry } from '../native-conversation-registry';
import type { NativeConversationAdapter } from '../native-conversation-adapter';

describe('NativeConversationRegistry', () => {
  it('registers, rejects duplicates, and lists capabilities', () => {
    const registry = new NativeConversationRegistry();
    const adapter = fakeAdapter('codex');
    registry.register(adapter);

    expect(registry.get('codex')).toBe(adapter);
    expect(() => registry.register(adapter)).toThrow(/already registered/);
    expect(registry.listCapabilities()).toMatchObject([{ provider: 'codex', canDiscover: true }]);
  });

  it('allows explicit test override', () => {
    const registry = new NativeConversationRegistry();
    registry.register(fakeAdapter('codex'));
    const replacement = fakeAdapter('codex');
    registry.register(replacement, { override: true });
    expect(registry.get('codex')).toBe(replacement);
  });
});

function fakeAdapter(provider: 'codex'): NativeConversationAdapter {
  return {
    provider,
    getCapabilities: () => ({
      provider,
      canDiscover: true,
      canRead: true,
      canCreate: true,
      canResume: true,
      canSendTurns: true,
      canReconcile: true,
      durableByDefault: true,
      nativeVisibilityMode: 'app-server-durable',
    }),
    discover: async () => [],
    readThread: async () => { throw new Error('not used'); },
    startThread: async () => { throw new Error('not used'); },
    resumeThread: async () => { throw new Error('not used'); },
    sendTurn: async () => { throw new Error('not used'); },
    reconcile: async () => { throw new Error('not used'); },
  };
}
