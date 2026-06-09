import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Fake adapter returned by the mocked factory. Records the options it was built
// with so we can assert on the injected chrome-devtools config.
class FakeAdapter extends EventEmitter {
  spawn = vi.fn(async () => 0);
  sendInput = vi.fn(async () => undefined);
  terminate = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
}

const createCliAdapter = vi.fn();

vi.mock('../main/cli/adapters/adapter-factory', () => ({
  createCliAdapter: (...args: unknown[]) => createCliAdapter(...args),
}));
vi.mock('../main/providers/adapter-runtime-event-bridge', () => ({
  observeAdapterRuntimeEvents: vi.fn(() => () => undefined),
}));
vi.mock('../main/providers/provider-output-event', () => ({
  toOutputMessageFromProviderOutputEvent: vi.fn(() => ({})),
}));

import { LocalInstanceManager } from './local-instance-manager';
import type { WorkerBrowserManager } from './worker-browser-manager';
import type { SpawnParams } from './local-instance-manager';

function baseParams(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    instanceId: 'inst-1',
    cliType: 'claude',
    workingDirectory: '/work',
    ...overrides,
  } as SpawnParams;
}

function fakeBrowserManager(
  over: Partial<{ enabled: boolean; ensureRunning: () => Promise<string> }> = {},
): WorkerBrowserManager {
  return {
    isEnabled: () => over.enabled ?? true,
    ensureRunning: over.ensureRunning ?? (async () => 'http://127.0.0.1:9333'),
    getBrowserUrl: () => null,
    shutdown: async () => undefined,
  } as unknown as WorkerBrowserManager;
}

/** The options object createCliAdapter was called with. */
function lastSpawnOptions(): Record<string, unknown> {
  return createCliAdapter.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('LocalInstanceManager browser injection', () => {
  beforeEach(() => {
    createCliAdapter.mockReset();
    createCliAdapter.mockImplementation(() => new FakeAdapter());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('injects chromeDevtoolsMcp when the browser manager is enabled', async () => {
    const mgr = new LocalInstanceManager(['/work'], 10, fakeBrowserManager({ enabled: true }));
    await mgr.spawn(baseParams());
    expect(lastSpawnOptions().chromeDevtoolsMcp).toEqual({ browserUrl: 'http://127.0.0.1:9333' });
  });

  it('does not inject when the browser manager is disabled', async () => {
    const mgr = new LocalInstanceManager(['/work'], 10, fakeBrowserManager({ enabled: false }));
    await mgr.spawn(baseParams());
    expect(lastSpawnOptions().chromeDevtoolsMcp).toBeUndefined();
  });

  it('does not inject when there is no browser manager', async () => {
    const mgr = new LocalInstanceManager(['/work'], 10, null);
    await mgr.spawn(baseParams());
    expect(lastSpawnOptions().chromeDevtoolsMcp).toBeUndefined();
  });

  it('degrades gracefully: spawn still succeeds without browser tools when Chrome fails to start', async () => {
    const mgr = new LocalInstanceManager(
      ['/work'],
      10,
      fakeBrowserManager({
        enabled: true,
        ensureRunning: async () => {
          throw new Error('chrome boom');
        },
      }),
    );
    await expect(mgr.spawn(baseParams())).resolves.toBeUndefined();
    expect(createCliAdapter).toHaveBeenCalledTimes(1);
    expect(lastSpawnOptions().chromeDevtoolsMcp).toBeUndefined();
  });
});
