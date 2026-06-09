import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoutingBrowserLauncher } from './routing-browser-launcher';
import type { RemoteBrowserConnector } from './remote-browser-connector';
import type { BrowserProcessLauncher } from './browser-process-launcher';
import type { BrowserProfile } from '@contracts/types/browser';

function profile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: 'p1',
    label: 'Test',
    mode: 'session',
    browser: 'chrome',
    userDataDir: '/data/p1',
    allowedOrigins: [],
    status: 'stopped',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeLauncher() {
  const local = {
    launchProfile: vi.fn(async () => ({ debugPort: 9222, debugEndpoint: 'ws://local' })),
    getBrowser: vi.fn(() => ({ kind: 'local' }) as never),
    closeProfile: vi.fn(async () => undefined),
  };
  const connector = {
    connect: vi.fn(async () => ({ debugPort: 0, debugEndpoint: 'remote://node-x' })),
    getBrowser: vi.fn(() => ({ kind: 'remote' }) as never),
    close: vi.fn(async () => undefined),
  };
  const launcher = new RoutingBrowserLauncher({
    local: local as unknown as BrowserProcessLauncher,
    connector: connector as unknown as RemoteBrowserConnector,
  });
  return { launcher, local, connector };
}

describe('RoutingBrowserLauncher', () => {
  let h: ReturnType<typeof makeLauncher>;
  beforeEach(() => {
    h = makeLauncher();
  });

  it('launches a local profile via the local launcher', async () => {
    await h.launcher.launchProfile({ profile: profile(), userDataDir: '/data/p1', startUrl: 'https://x' });
    expect(h.local.launchProfile).toHaveBeenCalledTimes(1);
    expect(h.connector.connect).not.toHaveBeenCalled();
  });

  it('routes a node-bound profile to the remote connector', async () => {
    await h.launcher.launchProfile({
      profile: profile({ executionNodeId: 'node-x' }),
      userDataDir: '/data/p1',
      startUrl: 'https://x',
    });
    expect(h.connector.connect).toHaveBeenCalledWith('p1', 'node-x', 'https://x');
    expect(h.local.launchProfile).not.toHaveBeenCalled();
  });

  it('getBrowser/closeProfile route to the remote connector for a remote profile', async () => {
    await h.launcher.launchProfile({ profile: profile({ executionNodeId: 'node-x' }), userDataDir: '/d' });
    expect(h.launcher.getBrowser('p1')).toEqual({ kind: 'remote' });
    expect(h.connector.getBrowser).toHaveBeenCalledWith('p1');

    await h.launcher.closeProfile('p1');
    expect(h.connector.close).toHaveBeenCalledWith('p1');
    expect(h.local.closeProfile).not.toHaveBeenCalled();
  });

  it('getBrowser/closeProfile route locally for a local profile', async () => {
    await h.launcher.launchProfile({ profile: profile(), userDataDir: '/d' });
    expect(h.launcher.getBrowser('p1')).toEqual({ kind: 'local' });
    expect(h.local.getBrowser).toHaveBeenCalledWith('p1');

    await h.launcher.closeProfile('p1');
    expect(h.local.closeProfile).toHaveBeenCalledWith('p1');
    expect(h.connector.close).not.toHaveBeenCalled();
  });

  it('un-marks a remote profile when the remote connect fails (so it does not strand)', async () => {
    h.connector.connect.mockRejectedValueOnce(new Error('no node'));
    await expect(
      h.launcher.launchProfile({ profile: profile({ executionNodeId: 'node-x' }), userDataDir: '/d' }),
    ).rejects.toThrow(/no node/);
    // After the failure the profile is not tracked remote — getBrowser falls local.
    h.launcher.getBrowser('p1');
    expect(h.local.getBrowser).toHaveBeenCalledWith('p1');
  });
});
