import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentBrowserSessionOwner, setBrowserSessionUserDataPathProvider, withBrowserSession, withBrowserSessionOfInstance } from './browser-session-context';
import { cancelSecretRecoveriesWhenStopped } from './browser-secret-recovery-wiring';

describe('secret recovery wiring', () => {
  afterEach(() => setBrowserSessionUserDataPathProvider(undefined));

  it('runs Harness-started work as the same browser owner as that session\'s own calls', () => {
    setBrowserSessionUserDataPathProvider(() => '/tmp/test-only-user-data');
    const rpcOwner = withBrowserSession('/tmp/test-only-user-data', 'session-1', () => currentBrowserSessionOwner());
    expect(withBrowserSessionOfInstance('session-1', () => currentBrowserSessionOwner())).toBe(rpcOwner);
    expect(withBrowserSessionOfInstance('session-2', () => currentBrowserSessionOwner())).not.toBe(rpcOwner);
  });

  it('keeps the owner across awaits inside the work', async () => {
    setBrowserSessionUserDataPathProvider(() => '/tmp/test-only-user-data');
    const owner = await withBrowserSessionOfInstance('session-1', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return currentBrowserSessionOwner();
    });
    expect(owner).toBe(withBrowserSession('/tmp/test-only-user-data', 'session-1', () => currentBrowserSessionOwner()));
  });

  it('cancels a session\'s recoveries when it is removed or a person stops it, not on automatic interrupts', () => {
    let removed!: (instanceId: string) => void;
    let interrupted!: (event: { instanceId: string; origin?: string }) => void;
    const expire = vi.fn();
    cancelSecretRecoveriesWhenStopped({
      onSessionRemoved: (listener) => { removed = listener; },
      onSessionInterrupted: (listener) => { interrupted = listener; },
    }, expire);
    removed('closed-session');
    for (const origin of ['renderer-ipc', 'mobile-gateway', 'channel-command', 'thin-client', 'pause']) {
      interrupted({ instanceId: `stopped-${origin}`, origin });
    }
    for (const origin of ['steer', 'tool-loop-auto', 'usage-overage', 'unknown', undefined]) {
      interrupted({ instanceId: 'auto-interrupted', origin });
    }
    expect(expire.mock.calls.map(([id]) => id)).toEqual([
      'closed-session', 'stopped-renderer-ipc', 'stopped-mobile-gateway', 'stopped-channel-command',
      'stopped-thin-client', 'stopped-pause',
    ]);
  });
});
