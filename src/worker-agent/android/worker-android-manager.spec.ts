import { describe, expect, it, vi } from 'vitest';
import type {
  AndroidDeviceInfo,
  WorkerNodeAndroidAutomationSummary,
} from '../../shared/types/worker-node.types';
import type { WorkerAndroidAutomationConfig } from '../worker-config';
import { WorkerAndroidManager } from './worker-android-manager';
import type { WorkerEmulatorManager } from './worker-emulator-manager';

const physical: AndroidDeviceInfo = {
  serial: 'USB123',
  kind: 'usb',
  state: 'device',
  model: 'Pixel 8',
  apiLevel: 35,
};

const emulator: AndroidDeviceInfo = {
  serial: 'emulator-5554',
  kind: 'emulator',
  state: 'device',
  model: 'Pixel 7',
  apiLevel: 35,
};

const baseConfig: WorkerAndroidAutomationConfig = {
  enabled: true,
  sdkPath: '/android/sdk',
  defaultAvd: 'aio-pixel7-api35',
  headlessEmulator: true,
  maxEmulators: 1,
  bootTimeoutMs: 180_000,
  allowPhysicalDevices: true,
  injectMaestroMcp: true,
  appiumMcp: false,
  mobileMcpVersion: '0.0.59',
};

function makeSummary(devices: AndroidDeviceInfo[] = [physical]): WorkerNodeAndroidAutomationSummary {
  return {
    enabled: true,
    sdkPath: '/android/sdk',
    adbVersion: 'Android Debug Bridge version 1.0.41',
    avds: ['aio-pixel7-api35'],
    connectedDevices: devices,
    emulatorRunning: false,
    hasMaestro: true,
  };
}

function makeEmulatorManager(runningSerials: string[] = []): WorkerEmulatorManager {
  return {
    ensureRunning: vi.fn(async () => emulator),
    cleanupOwnedOrphans: vi.fn(async () => undefined),
    getRunningSerials: vi.fn(() => runningSerials),
    reconfigure: vi.fn(async () => undefined),
    shutdownAll: vi.fn(async () => undefined),
  } as unknown as WorkerEmulatorManager;
}

describe('WorkerAndroidManager', () => {
  it('cleans up owned orphan emulators before the first capability summary', async () => {
    const calls: string[] = [];
    const emulatorManager = {
      ...makeEmulatorManager(),
      cleanupOwnedOrphans: vi.fn(async () => {
        calls.push('cleanup');
      }),
      getRunningSerials: vi.fn(() => {
        calls.push('running');
        return [];
      }),
    } as unknown as WorkerEmulatorManager;
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([]),
      emulatorManager,
    });

    await manager.getSummary();
    await manager.getSummary();

    expect(emulatorManager.cleanupOwnedOrphans).toHaveBeenCalledTimes(1);
    expect(calls[0]).toBe('cleanup');
  });

  it('does not make Android automation unusable when startup orphan cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emulatorManager = {
      ...makeEmulatorManager(),
      cleanupOwnedOrphans: vi.fn(async () => {
        throw new Error('cleanup denied');
      }),
    } as unknown as WorkerEmulatorManager;
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([]),
      emulatorManager,
    });

    try {
      await expect(manager.getSummary()).resolves.toMatchObject({
        sdkPath: '/android/sdk',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('merges managed emulator state into capability summaries', async () => {
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([]),
      emulatorManager: makeEmulatorManager(['emulator-5554']),
    });

    await expect(manager.getSummary()).resolves.toMatchObject({
      emulatorRunning: true,
      connectedDevices: [],
    });
  });

  it('includes the applied non-secret config in capability summaries for UI round-tripping', async () => {
    const manager = new WorkerAndroidManager({
      config: {
        ...baseConfig,
        headlessEmulator: false,
        maxEmulators: 3,
        bootTimeoutMs: 240_000,
        allowPhysicalDevices: false,
        injectMaestroMcp: false,
        appiumMcp: true,
      },
      detect: async () => makeSummary([]),
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.getSummary()).resolves.toMatchObject({
      defaultAvd: 'aio-pixel7-api35',
      headlessEmulator: false,
      maxEmulators: 3,
      bootTimeoutMs: 240_000,
      allowPhysicalDevices: false,
      injectMaestroMcp: false,
      appiumMcp: true,
      mobileMcpVersion: '0.0.59',
    });
  });

  it('resolves an Android attach with a leased serial, SDK path, and pinned mobile-mcp version', async () => {
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([]),
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.resolveAttachForInstance('inst-1', { kind: 'emulator' })).resolves.toEqual({
      serial: 'emulator-5554',
      kind: 'emulator',
      sdkPath: '/android/sdk',
      maestro: true,
      mobileMcpVersion: '0.0.59',
    });
  });

  it('releases the acquired lease if attach summary refresh fails', async () => {
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => {
        throw new Error('detect failed');
      },
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.resolveAttachForInstance('inst-1', { kind: 'emulator' }))
      .rejects.toThrow('detect failed');
    await expect(manager.acquireLeaseForInstance('inst-2', { kind: 'emulator' }))
      .resolves.toMatchObject({ serial: 'emulator-5554' });
  });

  it('blocks physical leases when physical devices are disabled', async () => {
    const manager = new WorkerAndroidManager({
      config: { ...baseConfig, allowPhysicalDevices: false },
      detect: async () => makeSummary([physical]),
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.acquireLeaseForInstance('inst-1', { kind: 'physical' }))
      .rejects.toThrow(/Physical Android devices are disabled/);
  });

  it('does not lease physical devices for any-kind requests when physical devices are disabled', async () => {
    const manager = new WorkerAndroidManager({
      config: { ...baseConfig, allowPhysicalDevices: false },
      detect: async () => makeSummary([physical]),
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.acquireLeaseForInstance('inst-1', { kind: 'any' }))
      .resolves.toMatchObject({
        serial: 'emulator-5554',
        kind: 'emulator',
      });
  });

  it('blocks specific physical serial requests when physical devices are disabled', async () => {
    const manager = new WorkerAndroidManager({
      config: { ...baseConfig, allowPhysicalDevices: false },
      detect: async () => makeSummary([physical]),
      emulatorManager: makeEmulatorManager(),
    });

    await expect(manager.acquireLeaseForInstance('inst-1', { serial: 'USB123' }))
      .rejects.toThrow(/Physical Android devices are disabled/);
  });

  it('releases leases and reconfigures the emulator manager when launch settings change', async () => {
    const emulatorManager = makeEmulatorManager();
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([physical]),
      emulatorManager,
    });

    await expect(manager.acquireLeaseForInstance('inst-1', { kind: 'physical' })).resolves.toMatchObject({
      serial: 'USB123',
    });
    await manager.reconfigure({ ...baseConfig, sdkPath: '/new-sdk' });
    await expect(manager.acquireLeaseForInstance('inst-2', { kind: 'physical' })).resolves.toMatchObject({
      serial: 'USB123',
    });
    expect(emulatorManager.reconfigure).toHaveBeenCalledWith({ ...baseConfig, sdkPath: '/new-sdk' });
  });

  it('shuts down leases and managed emulators', async () => {
    const emulatorManager = makeEmulatorManager();
    const manager = new WorkerAndroidManager({
      config: baseConfig,
      detect: async () => makeSummary([physical]),
      emulatorManager,
    });

    await manager.acquireLeaseForInstance('inst-1', { kind: 'physical' });
    await manager.shutdown();
    await expect(manager.acquireLeaseForInstance('inst-2', { kind: 'physical' })).resolves.toMatchObject({
      serial: 'USB123',
    });
    expect(emulatorManager.shutdownAll).toHaveBeenCalledTimes(1);
  });
});
