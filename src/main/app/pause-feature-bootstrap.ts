import { getSettingsManager, type SettingsManager } from '../core/config/settings-manager';
import type { AppSettings } from '../../shared/types/settings.types';
import { getLogger } from '../logging/logger';
import { AllowedHostMatcher, type AllowedHostsConfig } from '../network/allowed-hosts';
import {
  installNetworkPauseGate,
  type InstallNetworkPauseGateDeps,
} from '../network/install-network-pause-gate';
import {
  getVpnDetector,
  VpnDetector,
  type VpnDetectorConfig,
} from '../network/vpn-detector';
import {
  getPauseCoordinator,
  type PauseCoordinator,
  type PauseReason,
} from '../pause/pause-coordinator';

const logger = getLogger('PauseFeatureBootstrap');

type SettingsListener = (value: unknown) => void;
type Unsubscribe = () => void;

interface SettingsSource {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  on(eventName: string | symbol, listener: SettingsListener): this;
  off(eventName: string | symbol, listener: SettingsListener): this;
}

interface PauseCoordinatorSource {
  bootstrap(): void;
  isPaused(): boolean;
  addReason(reason: PauseReason, meta?: Record<string, unknown>): void;
  removeReason(reason: PauseReason): void;
  removeReasons(reasons: readonly PauseReason[], trigger?: string): void;
  clearAllReasons(trigger?: string): void;
  needsFirstScanForceVpnTreatment(): boolean;
  reconcileFirstEvaluation(vpnActive: boolean): void;
}

interface DetectorSource {
  start(): void;
  stop(): void;
  isVpnActive(): boolean;
  on(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
  off(eventName: string | symbol, listener: (...args: unknown[]) => void): this;
}

interface LoggerSource {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}

export interface PauseFeatureRuntimeDeps {
  settings: SettingsSource;
  coordinator: PauseCoordinatorSource;
  installGate: (deps: InstallNetworkPauseGateDeps) => Unsubscribe;
  createAllowedHosts: (cfg: AllowedHostsConfig) => AllowedHostMatcher;
  getDetector: (cfg: VpnDetectorConfig) => DetectorSource;
  resetDetector: () => void;
  clearPersistedQueues: () => void;
  logger: LoggerSource;
}

const DETECTOR_OWNED_REASONS: readonly PauseReason[] = ['vpn', 'detector-error'];
const INTERCEPTOR_SETTING_KEYS = [
  'pauseAllowPrivateRanges',
  'remoteNodesServerHost',
] as const satisfies readonly (keyof AppSettings)[];
const DETECTOR_SETTING_KEYS = [
  'pauseOnVpnEnabled',
  'pauseVpnInterfacePattern',
  'pauseTreatExistingVpnAsActive',
  'pauseDetectorDiagnostics',
  'pauseReachabilityProbeHost',
  'pauseReachabilityProbeMode',
  'pauseReachabilityProbeIntervalSec',
] as const satisfies readonly (keyof AppSettings)[];

export class PauseFeatureRuntime {
  private featureActive = false;
  private uninstallGate: Unsubscribe | null = null;
  private detector: DetectorSource | null = null;
  private readonly settingsCleanups: Unsubscribe[] = [];
  private readonly detectorCleanups: Unsubscribe[] = [];

  constructor(private readonly deps: PauseFeatureRuntimeDeps) {}

  start(): void {
    this.bindSettings();
    this.applyFeatureEnabled(this.deps.settings.get('pauseFeatureEnabled'));
  }

  dispose(): void {
    this.stopDetector();
    this.uninstallNetworkGate();
    for (const cleanup of this.settingsCleanups.splice(0)) cleanup();
  }

  private bindSettings(): void {
    this.onSetting('pauseFeatureEnabled', (enabled) => {
      this.applyFeatureEnabled(Boolean(enabled));
    });

    for (const key of INTERCEPTOR_SETTING_KEYS) {
      this.onSetting(key, () => {
        if (this.featureActive) this.reinstallNetworkGate();
      });
    }

    for (const key of DETECTOR_SETTING_KEYS) {
      this.onSetting(key, () => {
        if (!this.featureActive) return;
        if (key === 'pauseOnVpnEnabled' && !this.deps.settings.get('pauseOnVpnEnabled')) {
          this.stopDetector();
          this.deps.coordinator.removeReasons(DETECTOR_OWNED_REASONS, 'vpn-detection-disabled');
          return;
        }
        this.rebuildDetector();
      });
    }
  }

  private onSetting<K extends keyof AppSettings>(
    key: K,
    listener: (value: AppSettings[K]) => void
  ): void {
    const wrapped: SettingsListener = (value) => listener(value as AppSettings[K]);
    this.deps.settings.on(`setting:${key}`, wrapped);
    this.settingsCleanups.push(() => this.deps.settings.off(`setting:${key}`, wrapped));
  }

  private applyFeatureEnabled(enabled: boolean): void {
    if (!enabled) {
      this.deactivateFeature();
      return;
    }

    this.activateFeature();
  }

  private activateFeature(): void {
    if (this.featureActive) {
      this.reinstallNetworkGate();
      this.startDetectorIfEnabled({ clearDetectorReasons: false });
      return;
    }

    this.featureActive = true;
    this.deps.coordinator.bootstrap();
    this.reinstallNetworkGate();
    this.startDetectorIfEnabled({ clearDetectorReasons: false });
    this.deps.logger.info('Pause feature activated');
  }

  private deactivateFeature(): void {
    if (!this.featureActive) {
      this.deps.coordinator.clearAllReasons('pause-feature-disabled');
      this.deps.clearPersistedQueues();
      return;
    }

    this.featureActive = false;
    this.stopDetector();
    this.uninstallNetworkGate();
    this.deps.coordinator.clearAllReasons('pause-feature-disabled');
    this.deps.clearPersistedQueues();
    this.deps.logger.info('Pause feature deactivated');
  }

  private reinstallNetworkGate(): void {
    this.uninstallNetworkGate();
    this.uninstallGate = this.deps.installGate({
      coordinator: {
        isPaused: () => this.featureActive && this.deps.coordinator.isPaused(),
      },
      allowedHosts: this.deps.createAllowedHosts(this.allowedHostsConfig()),
    });
  }

  private uninstallNetworkGate(): void {
    this.uninstallGate?.();
    this.uninstallGate = null;
  }

  private startDetectorIfEnabled(options: { clearDetectorReasons: boolean }): void {
    if (!this.deps.settings.get('pauseOnVpnEnabled')) {
      this.stopDetector();
      this.deps.coordinator.removeReasons(DETECTOR_OWNED_REASONS, 'vpn-detection-disabled');
      return;
    }

    if (options.clearDetectorReasons) {
      this.deps.coordinator.removeReasons(DETECTOR_OWNED_REASONS, 'vpn-detector-rebuild');
    }

    this.stopDetector();
    const detector = this.deps.getDetector(this.detectorConfig());
    this.detector = detector;
    this.bindDetector(detector);
    detector.start();
  }

  private rebuildDetector(): void {
    this.startDetectorIfEnabled({ clearDetectorReasons: true });
  }

  private stopDetector(): void {
    const hadDetector = this.detector !== null || this.detectorCleanups.length > 0;
    for (const cleanup of this.detectorCleanups.splice(0)) cleanup();
    this.detector?.stop();
    this.detector = null;
    if (hadDetector) this.deps.resetDetector();
  }

  private bindDetector(detector: DetectorSource): void {
    const onVpnUp = (): void => {
      this.deps.coordinator.addReason('vpn');
      this.deps.coordinator.reconcileFirstEvaluation(true);
    };
    const onVpnDown = (): void => {
      this.deps.coordinator.removeReason('vpn');
      this.deps.coordinator.reconcileFirstEvaluation(false);
    };
    const onDetectorError = (error: unknown): void => {
      this.deps.coordinator.addReason('detector-error', {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const onFirstEvaluation = (): void => {
      this.deps.coordinator.reconcileFirstEvaluation(detector.isVpnActive());
    };

    detector.on('vpn-up', onVpnUp);
    detector.on('vpn-down', onVpnDown);
    detector.on('detector-error', onDetectorError);
    detector.on('first-evaluation-complete', onFirstEvaluation);
    detector.on('first-probe-completed', onFirstEvaluation);

    this.detectorCleanups.push(() => {
      detector.off('vpn-up', onVpnUp);
      detector.off('vpn-down', onVpnDown);
      detector.off('detector-error', onDetectorError);
      detector.off('first-evaluation-complete', onFirstEvaluation);
      detector.off('first-probe-completed', onFirstEvaluation);
    });
  }

  private allowedHostsConfig(): AllowedHostsConfig {
    const remoteHost = this.remoteNodeAllowedHost();
    return {
      allowPrivateRanges: this.deps.settings.get('pauseAllowPrivateRanges'),
      extraAllowedHosts: remoteHost ? [remoteHost] : [],
    };
  }

  private remoteNodeAllowedHost(): string | undefined {
    const raw = this.deps.settings.get('remoteNodesServerHost').trim();
    if (!raw || raw === '*' || raw === '0.0.0.0' || raw === '::' || raw === '[::]') {
      return undefined;
    }

    try {
      if (raw.includes('://')) return new URL(raw).hostname;
    } catch {
      this.deps.logger.warn('Ignoring invalid remote node host for pause allow-list', { raw });
      return undefined;
    }

    if (raw.startsWith('[')) {
      const closing = raw.indexOf(']');
      return closing === -1 ? raw : raw.slice(0, closing + 1);
    }

    const lastColon = raw.lastIndexOf(':');
    if (lastColon !== -1 && raw.indexOf(':') === lastColon) {
      return raw.slice(0, lastColon);
    }

    return raw;
  }

  private detectorConfig(): VpnDetectorConfig {
    let pattern: RegExp;
    try {
      pattern = new RegExp(this.deps.settings.get('pauseVpnInterfacePattern'));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.deps.logger.error('Invalid VPN detector pattern; pausing fail-closed', err, {
        pattern: this.deps.settings.get('pauseVpnInterfacePattern'),
      });
      this.deps.coordinator.addReason('detector-error');
      pattern = /a^/;
    }

    const probeHost = this.deps.settings.get('pauseReachabilityProbeHost').trim();
    return {
      pattern,
      treatExistingAsVpn: this.deps.settings.get('pauseTreatExistingVpnAsActive'),
      forceFirstScanVpnTreatment: this.deps.coordinator.needsFirstScanForceVpnTreatment(),
      diagnosticsEnabled: this.deps.settings.get('pauseDetectorDiagnostics'),
      probeMode: this.deps.settings.get('pauseReachabilityProbeMode'),
      probeHost: probeHost || undefined,
      probeIntervalSec: this.deps.settings.get('pauseReachabilityProbeIntervalSec'),
    };
  }
}

let runtime: PauseFeatureRuntime | null = null;

function clearPersistedInstanceQueues(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ElectronStore = require('electron-store').default as typeof import('electron-store').default;
    const store = new ElectronStore({ name: 'instance-message-queue' }) as unknown as {
      clear(): void;
    };
    store.clear();
  } catch (error) {
    logger.warn('Failed to clear persisted instance queues while disabling pause feature', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function initializePauseFeatureRuntime(): void {
  if (runtime) return;

  runtime = new PauseFeatureRuntime({
    settings: getSettingsManager() as SettingsManager,
    coordinator: getPauseCoordinator() as PauseCoordinator,
    installGate: installNetworkPauseGate,
    createAllowedHosts: (cfg) => new AllowedHostMatcher(cfg),
    getDetector: (cfg) => getVpnDetector(cfg),
    resetDetector: () => VpnDetector._resetForTesting(),
    clearPersistedQueues: clearPersistedInstanceQueues,
    logger,
  });
  runtime.start();
}

export function _resetPauseFeatureRuntimeForTesting(): void {
  runtime?.dispose();
  runtime = null;
}
