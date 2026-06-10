import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalInstanceManager, type SpawnParams } from './local-instance-manager';
import type { WorkerBrowserManager } from './worker-browser-manager';
import type { WorkerAndroidManager } from './android/worker-android-manager';

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

function baseParams(overrides: Partial<SpawnParams> = {}): SpawnParams {
  return {
    instanceId: 'inst-1',
    cliType: 'claude',
    workingDirectory: '/work',
    nodePlacement: { requiresAndroid: true },
    ...overrides,
  } as SpawnParams;
}

function androidManager(overrides: Partial<WorkerAndroidManager> = {}): WorkerAndroidManager {
  return {
    isEnabled: () => true,
    acquireLeaseForInstance: vi.fn(async () => ({
      instanceId: 'inst-1',
      serial: 'emulator-5554',
      kind: 'emulator',
      acquiredAt: 1,
      expiresAt: 2,
    })),
    releaseLeaseForInstance: vi.fn(),
    getSdkPath: () => '/android/sdk',
    shouldInjectMaestro: () => false,
    resolveAttachForInstance: vi.fn(async () => ({
      serial: 'emulator-5554',
      kind: 'emulator',
      sdkPath: '/android/sdk',
      maestro: false,
    })),
    ...overrides,
  } as unknown as WorkerAndroidManager;
}

function browserManager(overrides: Partial<WorkerBrowserManager> = {}): WorkerBrowserManager {
  return {
    isEnabled: () => true,
    ensureRunning: vi.fn(async () => 'http://127.0.0.1:9222'),
    ...overrides,
  } as unknown as WorkerBrowserManager;
}

function lastSpawnOptions(): Record<string, unknown> {
  return createCliAdapter.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

describe('LocalInstanceManager Android injection', () => {
  beforeEach(() => {
    createCliAdapter.mockReset();
    createCliAdapter.mockImplementation(() => new FakeAdapter());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('leases Android only when spawn placement requires it', async () => {
    const manager = androidManager();
    const mgr = new LocalInstanceManager(['/work'], 10, null, manager);

    await mgr.spawn(baseParams());

    expect(manager.resolveAttachForInstance).toHaveBeenCalledWith('inst-1', {
      kind: 'any',
    });
    expect(lastSpawnOptions().mobileMcp).toEqual({
      serial: 'emulator-5554',
      kind: 'emulator',
      sdkPath: '/android/sdk',
      maestro: false,
    });
    expect((lastSpawnOptions().env as Record<string, string>)['ANDROID_SERIAL']).toBe('emulator-5554');
    expect(lastSpawnOptions().systemPrompt).toContain('leased Android device `emulator-5554`');
  });

  it('propagates resolved Android attach version into mobile-mcp builder options', async () => {
    const manager = androidManager({
      resolveAttachForInstance: vi.fn(async () => ({
        serial: 'emulator-5556',
        kind: 'emulator',
        sdkPath: '/detected/sdk',
        maestro: true,
        mobileMcpVersion: '0.0.60',
      })),
    });
    const mgr = new LocalInstanceManager(['/work'], 10, null, manager);

    await mgr.spawn(baseParams());

    expect(lastSpawnOptions().mobileMcp).toEqual({
      serial: 'emulator-5556',
      kind: 'emulator',
      sdkPath: '/detected/sdk',
      maestro: true,
      version: '0.0.60',
    });
  });

  it('merges Android lease env with browser axe runner env', async () => {
    const mgr = new LocalInstanceManager(['/work'], 10, browserManager(), androidManager());

    await mgr.spawn(baseParams());

    const env = lastSpawnOptions().env as Record<string, string>;
    expect(env['ANDROID_SERIAL']).toBe('emulator-5554');
    expect(env['AIO_BROWSER_URL']).toBe('http://127.0.0.1:9222');
    expect(env['AIO_AXE_RUNNER']).toContain('axe-audit.mjs');
    expect(lastSpawnOptions().chromeDevtoolsMcp).toEqual({
      browserUrl: 'http://127.0.0.1:9222',
    });
  });

  it('does not lease Android for ordinary spawns', async () => {
    const manager = androidManager();
    const mgr = new LocalInstanceManager(['/work'], 10, null, manager);

    await mgr.spawn(baseParams({ nodePlacement: undefined }));

    expect(manager.resolveAttachForInstance).not.toHaveBeenCalled();
    expect(lastSpawnOptions().mobileMcp).toBeUndefined();
  });

  it('releases the lease when an adapter exits or spawn fails', async () => {
    const manager = androidManager();
    const mgr = new LocalInstanceManager(['/work'], 10, null, manager);
    const adapter = new FakeAdapter();
    createCliAdapter.mockReturnValue(adapter);

    await mgr.spawn(baseParams());
    adapter.emit('exit', { code: 0, signal: null });
    expect(manager.releaseLeaseForInstance).toHaveBeenCalledWith('inst-1');

    const failingAdapter = new FakeAdapter();
    failingAdapter.spawn = vi.fn(async () => {
      throw new Error('boom');
    });
    createCliAdapter.mockReturnValue(failingAdapter);
    await expect(mgr.spawn(baseParams({ instanceId: 'inst-2' }))).rejects.toThrow(/boom/);
    expect(manager.releaseLeaseForInstance).toHaveBeenCalledWith('inst-2');
  });
});
