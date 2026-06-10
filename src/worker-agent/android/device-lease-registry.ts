import type { AndroidDeviceInfo } from '../../shared/types/worker-node.types';

export interface AndroidDeviceLease {
  instanceId: string;
  serial: string;
  kind: AndroidDeviceInfo['kind'];
  acquiredAt: number;
  expiresAt: number;
}

export interface AndroidLeasePrefs {
  kind?: 'emulator' | 'physical' | 'any';
  serial?: string;
  avd?: string;
}

interface DeviceLeaseRegistryOptions {
  listDevices: () => Promise<AndroidDeviceInfo[]>;
  ensureEmulator: (avd?: string, excludedSerials?: ReadonlySet<string>) => Promise<AndroidDeviceInfo>;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;

export class DeviceLeaseRegistry {
  private readonly leasesBySerial = new Map<string, AndroidDeviceLease>();
  private readonly serialByInstance = new Map<string, string>();
  private readonly listDevices: () => Promise<AndroidDeviceInfo[]>;
  private readonly ensureEmulator: (avd?: string, excludedSerials?: ReadonlySet<string>) => Promise<AndroidDeviceInfo>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private acquireQueue: Promise<void> = Promise.resolve();

  constructor(options: DeviceLeaseRegistryOptions) {
    this.listDevices = options.listDevices;
    this.ensureEmulator = options.ensureEmulator;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async acquire(instanceId: string, prefs: AndroidLeasePrefs = {}): Promise<AndroidDeviceLease> {
    return this.runExclusive(() => this.acquireUnsafe(instanceId, prefs));
  }

  private async acquireUnsafe(instanceId: string, prefs: AndroidLeasePrefs): Promise<AndroidDeviceLease> {
    this.releaseExpired();
    this.release(instanceId);

    if (prefs.serial) {
      return this.acquireSpecific(instanceId, prefs.serial);
    }

    const kind = prefs.kind ?? 'any';
    if (kind === 'emulator') {
      const emulator = await this.ensureEmulator(prefs.avd, this.leasedSerials());
      return this.createLease(instanceId, emulator);
    }

    const devices = await this.listDevices();
    const physical = devices.find((device) =>
      isPhysical(device) && device.state === 'device' && !this.leasesBySerial.has(device.serial)
    );
    if (physical) {
      return this.createLease(instanceId, physical);
    }

    if (kind === 'physical') {
      throw new Error('No available physical Android device');
    }

    const emulator = await this.ensureEmulator(prefs.avd, this.leasedSerials());
    return this.createLease(instanceId, emulator);
  }

  release(instanceId: string): void {
    const serial = this.serialByInstance.get(instanceId);
    if (!serial) {
      return;
    }
    this.serialByInstance.delete(instanceId);
    this.leasesBySerial.delete(serial);
  }

  releaseAll(): void {
    this.serialByInstance.clear();
    this.leasesBySerial.clear();
  }

  getLease(instanceId: string): AndroidDeviceLease | undefined {
    const serial = this.serialByInstance.get(instanceId);
    return serial ? this.leasesBySerial.get(serial) : undefined;
  }

  private async acquireSpecific(instanceId: string, serial: string): Promise<AndroidDeviceLease> {
    const existing = this.leasesBySerial.get(serial);
    if (existing) {
      throw new Error(`Android device ${serial} is already leased`);
    }

    const devices = await this.listDevices();
    const device = devices.find((candidate) => candidate.serial === serial);
    if (!device) {
      throw new Error(`Android device ${serial} is not connected`);
    }
    if (device.state !== 'device') {
      throw new Error(`Android device ${serial} is not online`);
    }
    return this.createLease(instanceId, device);
  }

  private createLease(instanceId: string, device: AndroidDeviceInfo): AndroidDeviceLease {
    if (device.state !== 'device') {
      throw new Error(`Android device ${device.serial} is not online`);
    }

    const existing = this.leasesBySerial.get(device.serial);
    if (existing && existing.instanceId !== instanceId) {
      throw new Error(`Android device ${device.serial} is already leased`);
    }

    const acquiredAt = this.now();
    const lease: AndroidDeviceLease = {
      instanceId,
      serial: device.serial,
      kind: device.kind,
      acquiredAt,
      expiresAt: acquiredAt + this.ttlMs,
    };
    this.leasesBySerial.set(device.serial, lease);
    this.serialByInstance.set(instanceId, device.serial);
    return lease;
  }

  private releaseExpired(): void {
    const now = this.now();
    for (const lease of this.leasesBySerial.values()) {
      if (lease.expiresAt <= now) {
        this.release(lease.instanceId);
      }
    }
  }

  private leasedSerials(): ReadonlySet<string> {
    return new Set(this.leasesBySerial.keys());
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.acquireQueue;
    let release!: () => void;
    this.acquireQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isPhysical(device: AndroidDeviceInfo): boolean {
  return device.kind === 'usb' || device.kind === 'wifi';
}
