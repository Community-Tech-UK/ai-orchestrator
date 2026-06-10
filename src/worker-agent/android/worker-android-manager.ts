import type {
  AndroidDeviceInfo,
  WorkerNodeAndroidAutomationSummary,
} from '../../shared/types/worker-node.types';
import type { WorkerAndroidAutomationConfig } from '../worker-config';
import { detectAndroidAutomation } from './android-detect';
import {
  DeviceLeaseRegistry,
  type AndroidDeviceLease,
  type AndroidLeasePrefs,
} from './device-lease-registry';
import { WorkerEmulatorManager } from './worker-emulator-manager';

export interface WorkerAndroidAttach {
  serial: string;
  kind: AndroidDeviceInfo['kind'];
  sdkPath: string;
  maestro: boolean;
  mobileMcpVersion?: string;
}

interface WorkerAndroidManagerOptions {
  config: WorkerAndroidAutomationConfig;
  detect?: () => Promise<WorkerNodeAndroidAutomationSummary | undefined>;
  emulatorManager?: WorkerEmulatorManager;
  leaseRegistry?: DeviceLeaseRegistry;
}

export class WorkerAndroidManager {
  private config: WorkerAndroidAutomationConfig;
  private readonly detectSummary: () => Promise<WorkerNodeAndroidAutomationSummary | undefined>;
  private readonly emulatorManager: WorkerEmulatorManager;
  private readonly leaseRegistry: DeviceLeaseRegistry;
  private readonly startupCleanup: Promise<void>;
  private lastSummary: WorkerNodeAndroidAutomationSummary | undefined;

  constructor(options: WorkerAndroidManagerOptions) {
    this.config = options.config;
    this.emulatorManager = options.emulatorManager ?? new WorkerEmulatorManager({ config: options.config });
    this.startupCleanup = this.emulatorManager.cleanupOwnedOrphans().catch((error) => {
      console.warn(
        '[WorkerAndroidManager] failed to clean up owned Android emulator orphans; continuing',
        error instanceof Error ? error.message : String(error),
      );
    });
    this.detectSummary = options.detect ?? (() => detectAndroidAutomation({ config: this.config }));
    this.leaseRegistry = options.leaseRegistry ?? new DeviceLeaseRegistry({
      listDevices: async () => (await this.getSummary())?.connectedDevices ?? [],
      ensureEmulator: (avd, excludedSerials) =>
        this.emulatorManager.ensureRunning(avd ?? this.config.defaultAvd, excludedSerials),
    });
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  getSdkPath(): string {
    return this.lastSummary?.sdkPath ?? this.config.sdkPath ?? '';
  }

  shouldInjectMaestro(): boolean {
    return this.config.injectMaestroMcp === true && this.lastSummary?.hasMaestro === true;
  }

  async getSummary(): Promise<WorkerNodeAndroidAutomationSummary | undefined> {
    await this.startupCleanup;
    const summary = await this.detectSummary();
    this.lastSummary = summary
      ? {
          ...summary,
          emulatorRunning: summary.emulatorRunning || this.emulatorManager.getRunningSerials().length > 0,
          ...this.getConfigSummaryFields(),
        }
      : undefined;
    return this.lastSummary;
  }

  async acquireLeaseForInstance(
    instanceId: string,
    prefs: AndroidLeasePrefs = {},
  ): Promise<AndroidDeviceLease> {
    await this.startupCleanup;
    if (!this.isEnabled()) {
      throw new Error('Android automation is not enabled on this worker');
    }
    const physicalDevicesDisabled = this.config.allowPhysicalDevices === false;
    if (
      physicalDevicesDisabled &&
      prefs.serial &&
      !isEmulatorSerial(prefs.serial)
    ) {
      throw new Error('Physical Android devices are disabled on this worker');
    }
    const requestedKind = prefs.kind ?? 'any';
    if (requestedKind === 'physical' && physicalDevicesDisabled) {
      throw new Error('Physical Android devices are disabled on this worker');
    }
    const effectiveKind = physicalDevicesDisabled && requestedKind === 'any'
      ? 'emulator'
      : requestedKind;
    const effectivePrefs: AndroidLeasePrefs = {
      ...prefs,
      kind: effectiveKind,
      avd: prefs.avd ?? this.config.defaultAvd,
    };
    return this.leaseRegistry.acquire(instanceId, effectivePrefs);
  }

  releaseLeaseForInstance(instanceId: string): void {
    this.leaseRegistry.release(instanceId);
  }

  async resolveAttachForInstance(
    instanceId: string,
    prefs: AndroidLeasePrefs = {},
  ): Promise<WorkerAndroidAttach> {
    const lease = await this.acquireLeaseForInstance(instanceId, prefs);
    try {
      const summary = await this.getSummary();
      return {
        serial: lease.serial,
        kind: lease.kind,
        sdkPath: summary?.sdkPath ?? this.config.sdkPath ?? '',
        maestro: this.config.injectMaestroMcp === true && summary?.hasMaestro === true,
        ...(this.config.mobileMcpVersion ? { mobileMcpVersion: this.config.mobileMcpVersion } : {}),
      };
    } catch (error) {
      this.releaseLeaseForInstance(instanceId);
      throw error;
    }
  }

  async reconfigure(next: WorkerAndroidAutomationConfig): Promise<void> {
    await this.startupCleanup;
    const prev = this.config;
    this.config = next;
    const relevantChanged =
      prev.sdkPath !== next.sdkPath ||
      prev.defaultAvd !== next.defaultAvd ||
      prev.headlessEmulator !== next.headlessEmulator ||
      prev.maxEmulators !== next.maxEmulators ||
      prev.bootTimeoutMs !== next.bootTimeoutMs ||
      prev.allowPhysicalDevices !== next.allowPhysicalDevices;
    if (prev.enabled && (!next.enabled || relevantChanged)) {
      this.leaseRegistry.releaseAll();
    }
    await this.emulatorManager.reconfigure(next);
  }

  async shutdown(): Promise<void> {
    await this.startupCleanup;
    this.leaseRegistry.releaseAll();
    await this.emulatorManager.shutdownAll();
  }

  private getConfigSummaryFields(): Partial<WorkerNodeAndroidAutomationSummary> {
    return {
      ...(this.config.defaultAvd ? { defaultAvd: this.config.defaultAvd } : {}),
      ...(typeof this.config.headlessEmulator === 'boolean'
        ? { headlessEmulator: this.config.headlessEmulator }
        : {}),
      ...(typeof this.config.maxEmulators === 'number'
        ? { maxEmulators: this.config.maxEmulators }
        : {}),
      ...(typeof this.config.bootTimeoutMs === 'number'
        ? { bootTimeoutMs: this.config.bootTimeoutMs }
        : {}),
      ...(typeof this.config.allowPhysicalDevices === 'boolean'
        ? { allowPhysicalDevices: this.config.allowPhysicalDevices }
        : {}),
      ...(typeof this.config.injectMaestroMcp === 'boolean'
        ? { injectMaestroMcp: this.config.injectMaestroMcp }
        : {}),
      ...(typeof this.config.appiumMcp === 'boolean'
        ? { appiumMcp: this.config.appiumMcp }
        : {}),
      ...(this.config.mobileMcpVersion ? { mobileMcpVersion: this.config.mobileMcpVersion } : {}),
    };
  }
}

function isEmulatorSerial(serial: string): boolean {
  return serial.startsWith('emulator-');
}
