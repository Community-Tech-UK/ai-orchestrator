import { describe, expect, it, vi } from 'vitest';
import type { AndroidDeviceInfo } from '../../shared/types/worker-node.types';
import { DeviceLeaseRegistry } from './device-lease-registry';

const emulator: AndroidDeviceInfo = {
  serial: 'emulator-5554',
  kind: 'emulator',
  state: 'device',
  model: 'Pixel 7',
  apiLevel: 35,
};

const physical: AndroidDeviceInfo = {
  serial: 'USB123',
  kind: 'usb',
  state: 'device',
  model: 'Pixel 8',
  apiLevel: 34,
};

describe('DeviceLeaseRegistry', () => {
  it('leases one serial at a time and releases by instance id', async () => {
    const registry = new DeviceLeaseRegistry({
      listDevices: async () => [physical],
      ensureEmulator: vi.fn(),
      now: () => 10,
    });

    await expect(registry.acquire('inst-1', { kind: 'physical' })).resolves.toMatchObject({
      instanceId: 'inst-1',
      serial: 'USB123',
      kind: 'usb',
    });
    await expect(registry.acquire('inst-2', { kind: 'physical' })).rejects.toThrow(/No available physical Android device/);

    registry.release('inst-1');
    await expect(registry.acquire('inst-2', { kind: 'physical' })).resolves.toMatchObject({
      instanceId: 'inst-2',
      serial: 'USB123',
    });
  });

  it('boots an emulator for emulator leases and expires stale leases', async () => {
    let now = 1_000;
    const ensureEmulator = vi.fn(async () => emulator);
    const registry = new DeviceLeaseRegistry({
      listDevices: async () => [],
      ensureEmulator,
      now: () => now,
      ttlMs: 100,
    });

    await expect(registry.acquire('inst-1', { kind: 'emulator', avd: 'aio' })).resolves.toMatchObject({
      serial: 'emulator-5554',
      kind: 'emulator',
    });
    expect(ensureEmulator).toHaveBeenCalledWith('aio', new Set());

    now = 1_101;
    await expect(registry.acquire('inst-2', { kind: 'emulator', avd: 'aio' })).resolves.toMatchObject({
      instanceId: 'inst-2',
      serial: 'emulator-5554',
    });
  });

  it('serializes concurrent emulator leases so each instance gets an unleased serial', async () => {
    const ensureEmulator = vi.fn(async (_avd?: string, excluded?: ReadonlySet<string>) => ({
      serial: excluded?.has('emulator-5554') ? 'emulator-5556' : 'emulator-5554',
      kind: 'emulator' as const,
      state: 'device' as const,
    }));
    const registry = new DeviceLeaseRegistry({
      listDevices: async () => [],
      ensureEmulator,
      now: () => 1_000,
    });

    const [first, second] = await Promise.all([
      registry.acquire('inst-1', { kind: 'emulator', avd: 'aio' }),
      registry.acquire('inst-2', { kind: 'emulator', avd: 'aio' }),
    ]);

    expect(first.serial).toBe('emulator-5554');
    expect(second.serial).toBe('emulator-5556');
    expect(ensureEmulator).toHaveBeenNthCalledWith(1, 'aio', expect.any(Set));
    expect(ensureEmulator).toHaveBeenNthCalledWith(2, 'aio', new Set(['emulator-5554']));
  });

  it('honors a specific serial request only when the device is online and unleased', async () => {
    const registry = new DeviceLeaseRegistry({
      listDevices: async () => [physical, { ...emulator, state: 'offline' }],
      ensureEmulator: vi.fn(),
    });

    await expect(registry.acquire('inst-1', { serial: 'USB123' })).resolves.toMatchObject({
      serial: 'USB123',
    });
    await expect(registry.acquire('inst-2', { serial: 'USB123' })).rejects.toThrow(/already leased/);
    await expect(registry.acquire('inst-3', { serial: 'emulator-5554' })).rejects.toThrow(/not online/);
  });
});
