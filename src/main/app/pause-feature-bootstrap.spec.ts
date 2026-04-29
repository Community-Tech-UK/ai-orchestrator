import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import { AllowedHostMatcher, type AllowedHostsConfig } from '../network/allowed-hosts';
import type { InstallNetworkPauseGateDeps } from '../network/install-network-pause-gate';
import type { PauseReason } from '../pause/pause-coordinator';
import { PauseFeatureRuntime, type PauseFeatureRuntimeDeps } from './pause-feature-bootstrap';

class FakeSettings extends EventEmitter {
  private values: AppSettings = { ...DEFAULT_SETTINGS };

  setValue<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.values[key] = value;
    this.emit(`setting:${key}`, value);
  }

  get<K extends keyof AppSettings>(key: K): AppSettings[K] {
    return this.values[key];
  }
}

class FakeCoordinator {
  paused = false;
  forceFirstEvaluation = false;
  bootstrap = vi.fn();
  addReason = vi.fn((reason: PauseReason) => {
    this.paused = true;
    void reason;
  });
  removeReason = vi.fn();
  removeReasons = vi.fn();
  clearAllReasons = vi.fn(() => {
    this.paused = false;
  });
  needsFirstScanForceVpnTreatment = vi.fn(() => this.forceFirstEvaluation);
  reconcileFirstEvaluation = vi.fn();

  isPaused(): boolean {
    return this.paused;
  }
}

class FakeDetector extends EventEmitter {
  active = false;
  start = vi.fn();
  stop = vi.fn();

  isVpnActive(): boolean {
    return this.active;
  }
}

function makeDeps(overrides: Partial<AppSettings> = {}): {
  deps: PauseFeatureRuntimeDeps;
  settings: FakeSettings;
  coordinator: FakeCoordinator;
  detector: FakeDetector;
  installedGates: InstallNetworkPauseGateDeps[];
  uninstallGate: ReturnType<typeof vi.fn>;
  allowedConfigs: AllowedHostsConfig[];
  getDetector: ReturnType<typeof vi.fn>;
} {
  const settings = new FakeSettings();
  for (const [key, value] of Object.entries(overrides)) {
    settings.setValue(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
  }

  const coordinator = new FakeCoordinator();
  const detector = new FakeDetector();
  const installedGates: InstallNetworkPauseGateDeps[] = [];
  const allowedConfigs: AllowedHostsConfig[] = [];
  const uninstallGate = vi.fn();
  const getDetector = vi.fn(() => detector);

  return {
    deps: {
      settings,
      coordinator,
      installGate: vi.fn((gateDeps: InstallNetworkPauseGateDeps) => {
        installedGates.push(gateDeps);
        return uninstallGate;
      }),
      createAllowedHosts: vi.fn((cfg: AllowedHostsConfig) => {
        allowedConfigs.push(cfg);
        return new AllowedHostMatcher(cfg);
      }),
      getDetector,
      resetDetector: vi.fn(),
      clearPersistedQueues: vi.fn(),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    settings,
    coordinator,
    detector,
    installedGates,
    uninstallGate,
    allowedConfigs,
    getDetector,
  };
}

describe('PauseFeatureRuntime', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the feature fully disabled when the kill switch is off at startup', () => {
    const { deps, coordinator, getDetector } = makeDeps({ pauseFeatureEnabled: false });

    new PauseFeatureRuntime(deps).start();

    expect(coordinator.bootstrap).not.toHaveBeenCalled();
    expect(coordinator.clearAllReasons).toHaveBeenCalledWith('pause-feature-disabled');
    expect(deps.clearPersistedQueues).toHaveBeenCalledOnce();
    expect(deps.installGate).not.toHaveBeenCalled();
    expect(getDetector).not.toHaveBeenCalled();
  });

  it('installs the gate and clears detector reasons when VPN detection is disabled', () => {
    const { deps, coordinator, allowedConfigs, getDetector } = makeDeps({
      pauseOnVpnEnabled: false,
      pauseAllowPrivateRanges: true,
      remoteNodesServerHost: 'worker.local:4878',
    });

    new PauseFeatureRuntime(deps).start();

    expect(coordinator.bootstrap).toHaveBeenCalledOnce();
    expect(deps.installGate).toHaveBeenCalledOnce();
    expect(allowedConfigs[0]).toEqual({
      allowPrivateRanges: true,
      extraAllowedHosts: ['worker.local'],
    });
    expect(coordinator.removeReasons).toHaveBeenCalledWith(
      ['vpn', 'detector-error'],
      'vpn-detection-disabled'
    );
    expect(getDetector).not.toHaveBeenCalled();
  });

  it('stops detector and clears every pause reason when the kill switch turns off', () => {
    const { deps, settings, detector, coordinator, uninstallGate } = makeDeps();
    new PauseFeatureRuntime(deps).start();

    settings.setValue('pauseFeatureEnabled', false);

    expect(detector.stop).toHaveBeenCalledOnce();
    expect(uninstallGate).toHaveBeenCalledOnce();
    expect(coordinator.clearAllReasons).toHaveBeenCalledWith('pause-feature-disabled');
    expect(deps.clearPersistedQueues).toHaveBeenCalledOnce();
  });

  it('rebuilds detector-owned state when detector settings change', () => {
    const { deps, settings, detector, coordinator, getDetector } = makeDeps();
    new PauseFeatureRuntime(deps).start();

    settings.setValue('pauseVpnInterfacePattern', '^tun[0-9]+$');

    expect(detector.stop).toHaveBeenCalledOnce();
    expect(deps.resetDetector).toHaveBeenCalledOnce();
    expect(coordinator.removeReasons).toHaveBeenCalledWith(
      ['vpn', 'detector-error'],
      'vpn-detector-rebuild'
    );
    expect(getDetector).toHaveBeenCalledTimes(2);
    expect(getDetector.mock.calls[1][0].pattern.test('tun0')).toBe(true);
  });

  it('reconciles fail-closed detector state after first scan or probe', () => {
    const { deps, detector, coordinator } = makeDeps();
    coordinator.forceFirstEvaluation = true;
    new PauseFeatureRuntime(deps).start();

    detector.active = false;
    detector.emit('first-evaluation-complete');
    expect(coordinator.reconcileFirstEvaluation).toHaveBeenCalledWith(false);

    detector.active = true;
    detector.emit('first-probe-completed');
    expect(coordinator.reconcileFirstEvaluation).toHaveBeenCalledWith(true);
  });
});
