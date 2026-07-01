import { EventEmitter } from 'events';
import type { PluginProviderName } from '@contracts/types/provider-runtime-events';
import type { CliShadowReport, CliType } from '../cli/cli-detection';
import type { AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import type { HealthStatus } from '../core/system/health-checker';
import type {
  DiagnosisResult,
  ProbeResult,
} from './provider-doctor';

export type ProviderRuntimeProvider = CliType | 'anthropic-api' | PluginProviderName;

export type ProviderRuntimeStatus =
  | 'unknown'
  | 'available'
  | 'degraded'
  | 'unavailable';

export type ProviderRuntimeLifecycleEventType =
  | 'available'
  | 'degraded'
  | 'unavailable'
  | 'refreshed';

export type ProviderRuntimeSource =
  | 'adapter-created'
  | 'adapter-create-failed'
  | 'doctor'
  | 'manual';

export interface ProviderRuntimeDescriptor {
  kind: 'local-cli' | 'remote-cli' | 'api' | 'unknown';
  command?: string;
  cwd?: string;
  executionLocation?: ExecutionLocation;
}

export interface ProviderRuntimeErrorSnapshot {
  message: string;
  kind?: string;
  source: ProviderRuntimeSource;
}

export interface ProviderRuntimeDiagnosisSnapshot {
  provider: string;
  overall: HealthStatus;
  failedProbeNames: string[];
  recommendations: string[];
  repairActionCount: number;
  timestamp: number;
}

export interface ProviderRuntimeSnapshot {
  provider: ProviderRuntimeProvider;
  status: ProviderRuntimeStatus;
  runtime: ProviderRuntimeDescriptor;
  source: ProviderRuntimeSource;
  lastUpdatedAt: number;
  lastAvailableAt?: number;
  lastDegradedAt?: number;
  lastUnavailableAt?: number;
  lastRefreshedAt?: number;
  model?: string;
  capabilities?: AdapterRuntimeCapabilities;
  diagnosis?: ProviderRuntimeDiagnosisSnapshot;
  shadowReport?: CliShadowReport;
  error?: ProviderRuntimeErrorSnapshot;
}

export interface ProviderRuntimeLifecycleEvent {
  type: ProviderRuntimeLifecycleEventType;
  provider: ProviderRuntimeProvider;
  previousStatus: ProviderRuntimeStatus;
  snapshot: ProviderRuntimeSnapshot;
}

export interface RecordAvailableInput {
  provider: ProviderRuntimeProvider;
  runtime?: ProviderRuntimeDescriptor;
  capabilities?: AdapterRuntimeCapabilities;
  model?: string;
  source?: ProviderRuntimeSource;
}

export interface RecordUnavailableInput {
  provider: ProviderRuntimeProvider;
  message: string;
  kind?: string;
  source?: ProviderRuntimeSource;
  runtime?: ProviderRuntimeDescriptor;
}

export interface RecordDegradedInput {
  provider: ProviderRuntimeProvider;
  message: string;
  kind?: string;
  source?: ProviderRuntimeSource;
  runtime?: ProviderRuntimeDescriptor;
}

export interface ProviderRuntimeRegistryOptions {
  now?: () => number;
}

const DEFAULT_RUNTIME: ProviderRuntimeDescriptor = { kind: 'unknown' };

export class ProviderRuntimeRegistry extends EventEmitter {
  private static instance: ProviderRuntimeRegistry | null = null;

  private readonly snapshots = new Map<ProviderRuntimeProvider, ProviderRuntimeSnapshot>();
  private readonly now: () => number;

  constructor(options: ProviderRuntimeRegistryOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
  }

  static getInstance(): ProviderRuntimeRegistry {
    ProviderRuntimeRegistry.instance ??= new ProviderRuntimeRegistry();
    return ProviderRuntimeRegistry.instance;
  }

  static _resetForTesting(): void {
    ProviderRuntimeRegistry.instance?.removeAllListeners();
    ProviderRuntimeRegistry.instance = null;
  }

  getSnapshot(provider: ProviderRuntimeProvider): ProviderRuntimeSnapshot | undefined {
    return this.snapshots.get(provider);
  }

  listSnapshots(): ProviderRuntimeSnapshot[] {
    return Array.from(this.snapshots.values())
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  recordAvailable(input: RecordAvailableInput): ProviderRuntimeSnapshot {
    const timestamp = this.now();
    const previous = this.snapshotOrDefault(input.provider);
    const next: ProviderRuntimeSnapshot = {
      ...previous,
      provider: input.provider,
      status: 'available',
      runtime: input.runtime ?? previous.runtime,
      source: input.source ?? 'manual',
      lastUpdatedAt: timestamp,
      lastAvailableAt: timestamp,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      ...(input.model ? { model: input.model } : {}),
      error: undefined,
    };
    return this.setSnapshot(previous, next, previous.status === 'available' ? 'refreshed' : 'available');
  }

  recordUnavailable(input: RecordUnavailableInput): ProviderRuntimeSnapshot {
    const timestamp = this.now();
    const previous = this.snapshotOrDefault(input.provider);
    const next: ProviderRuntimeSnapshot = {
      ...previous,
      provider: input.provider,
      status: 'unavailable',
      runtime: input.runtime ?? previous.runtime,
      source: input.source ?? 'manual',
      lastUpdatedAt: timestamp,
      lastUnavailableAt: timestamp,
      error: {
        message: input.message,
        ...(input.kind ? { kind: input.kind } : {}),
        source: input.source ?? 'manual',
      },
    };
    return this.setSnapshot(previous, next, previous.status === 'unavailable' ? 'refreshed' : 'unavailable');
  }

  recordDegraded(input: RecordDegradedInput): ProviderRuntimeSnapshot {
    const timestamp = this.now();
    const previous = this.snapshotOrDefault(input.provider);
    const next: ProviderRuntimeSnapshot = {
      ...previous,
      provider: input.provider,
      status: 'degraded',
      runtime: input.runtime ?? previous.runtime,
      source: input.source ?? 'manual',
      lastUpdatedAt: timestamp,
      lastDegradedAt: timestamp,
      error: {
        message: input.message,
        ...(input.kind ? { kind: input.kind } : {}),
        source: input.source ?? 'manual',
      },
    };
    return this.setSnapshot(previous, next, previous.status === 'degraded' ? 'refreshed' : 'degraded');
  }

  applyDiagnosis(diagnosis: DiagnosisResult): ProviderRuntimeSnapshot {
    const provider = normalizeDiagnosisProvider(diagnosis.provider);
    const timestamp = this.now();
    const previous = this.snapshotOrDefault(provider);
    const failedProbe = diagnosis.probes.find((p) => p.status === 'fail');
    const shadowReport = extractShadowReport(diagnosis.probes) ?? previous.shadowReport;
    const diagnosisSnapshot: ProviderRuntimeDiagnosisSnapshot = {
      provider: diagnosis.provider,
      overall: diagnosis.overall,
      failedProbeNames: diagnosis.probes
        .filter((probe) => probe.status === 'fail')
        .map((probe) => probe.name),
      recommendations: [...diagnosis.recommendations],
      repairActionCount: diagnosis.repairActions.length,
      timestamp: diagnosis.timestamp,
    };

    const status = diagnosisToRuntimeStatus(diagnosis.overall);
    const next: ProviderRuntimeSnapshot = {
      ...previous,
      provider,
      status,
      source: 'doctor',
      lastUpdatedAt: timestamp,
      lastRefreshedAt: timestamp,
      diagnosis: diagnosisSnapshot,
      ...(shadowReport ? { shadowReport } : {}),
      ...(status === 'available' ? { lastAvailableAt: timestamp, error: undefined } : {}),
      ...(status === 'degraded'
        ? {
            lastDegradedAt: timestamp,
            error: failedProbe ? errorFromProbe(failedProbe, 'doctor') : previous.error,
          }
        : {}),
      ...(status === 'unavailable'
        ? {
            lastUnavailableAt: timestamp,
            error: failedProbe ? errorFromProbe(failedProbe, 'doctor') : previous.error,
          }
        : {}),
    };

    const eventType =
      previous.status === status
        ? 'refreshed'
        : status === 'available'
          ? 'available'
          : status === 'degraded'
            ? 'degraded'
            : 'unavailable';
    return this.setSnapshot(previous, next, eventType);
  }

  private snapshotOrDefault(provider: ProviderRuntimeProvider): ProviderRuntimeSnapshot {
    return this.snapshots.get(provider) ?? {
      provider,
      status: 'unknown',
      runtime: DEFAULT_RUNTIME,
      source: 'manual',
      lastUpdatedAt: 0,
    };
  }

  private setSnapshot(
    previous: ProviderRuntimeSnapshot,
    next: ProviderRuntimeSnapshot,
    type: ProviderRuntimeLifecycleEventType,
  ): ProviderRuntimeSnapshot {
    this.snapshots.set(next.provider, next);
    const event: ProviderRuntimeLifecycleEvent = {
      type,
      provider: next.provider,
      previousStatus: previous.status,
      snapshot: next,
    };
    this.emit('runtime:lifecycle', event);
    return next;
  }
}

export function getProviderRuntimeRegistry(): ProviderRuntimeRegistry {
  return ProviderRuntimeRegistry.getInstance();
}

export function _resetProviderRuntimeRegistryForTesting(): void {
  ProviderRuntimeRegistry._resetForTesting();
}

export function normalizeDiagnosisProvider(provider: string): ProviderRuntimeProvider {
  if (provider.startsWith('plugin:')) {
    return provider as PluginProviderName;
  }

  switch (provider) {
    case 'claude-cli':
      return 'claude';
    case 'codex-cli':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    case 'anthropic-api':
      return 'anthropic-api';
    case 'copilot':
    case 'cursor':
    case 'ollama':
      return provider;
    default:
      return provider.replace(/-cli$/, '') as ProviderRuntimeProvider;
  }
}

export function runtimeDescriptorForSpawn(
  cliType: CliType,
  workingDirectory?: string,
  executionLocation?: ExecutionLocation,
): ProviderRuntimeDescriptor {
  if (executionLocation?.type === 'remote') {
    return {
      kind: 'remote-cli',
      command: cliType,
      cwd: workingDirectory,
      executionLocation,
    };
  }

  return {
    kind: 'local-cli',
    command: cliType,
    cwd: workingDirectory,
  };
}

function diagnosisToRuntimeStatus(overall: HealthStatus): ProviderRuntimeStatus {
  switch (overall) {
    case 'healthy':
      return 'available';
    case 'degraded':
      return 'degraded';
    case 'unhealthy':
      return 'unavailable';
    default:
      return 'degraded';
  }
}

function extractShadowReport(probes: ProbeResult[]): CliShadowReport | undefined {
  const probe = probes.find((candidate) => candidate.name === 'cli_shadow_check');
  const report = probe?.metadata?.['report'];
  if (!report || typeof report !== 'object') return undefined;
  return report as unknown as CliShadowReport;
}

function errorFromProbe(
  probe: ProbeResult,
  source: ProviderRuntimeSource,
): ProviderRuntimeErrorSnapshot {
  return {
    message: probe.message,
    ...(probe.errorKind ? { kind: probe.errorKind } : {}),
    source,
  };
}
