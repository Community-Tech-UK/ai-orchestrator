import {
  createCliAdapter,
  type CliAdapter,
  type UnifiedSpawnOptions,
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  AdapterRuntimeCapabilities,
  InterruptResult,
  ResumeAttemptResult,
} from '../cli/adapters/base-cli-adapter';
import { getSettingsManager } from '../core/config/settings-manager';
import { CliAdapterWorkerProxy } from '../cli/spawn-worker/cli-adapter-worker-proxy';
import {
  getCliSpawnWorkerGateway,
  type CliSpawnGatewayPort,
} from '../cli/spawn-worker/cli-spawn-worker-gateway';
import {
  getProviderRuntimeRegistry,
  runtimeDescriptorForSpawn,
  type ProviderRuntimeRegistry,
} from './provider-runtime-registry';

export interface ProviderRuntimeStartInput {
  cliType: CliType;
  options: UnifiedSpawnOptions;
  executionLocation?: ExecutionLocation;
}

export interface ProviderRuntimeContract {
  createAdapter(input: ProviderRuntimeStartInput): CliAdapter;
  getCapabilities(adapter?: CliAdapter): AdapterRuntimeCapabilities;
  interruptTurn(adapter: CliAdapter): InterruptResult;
  getResumeProof(adapter?: CliAdapter): ResumeAttemptResult | undefined;
}

export type ProviderRuntimeAdapterCreator = (input: ProviderRuntimeStartInput) => CliAdapter;

export interface ProviderRuntimeServiceDeps {
  registry?: ProviderRuntimeRegistry;
  createAdapter?: ProviderRuntimeAdapterCreator;
  settings?: Partial<Pick<ReturnType<typeof getSettingsManager>, 'get'>>;
  spawnWorkerGateway?: CliSpawnGatewayPort;
}

const DEFAULT_RUNTIME_CAPABILITIES: AdapterRuntimeCapabilities = {
  supportsResume: false,
  supportsForkSession: false,
  supportsNativeCompaction: false,
  supportsPermissionPrompts: false,
  supportsDeferPermission: false,
  selfManagedAutoCompaction: false,
};

export class ProviderRuntimeService implements ProviderRuntimeContract {
  private readonly registry: ProviderRuntimeRegistry;
  private readonly createAdapterFn: ProviderRuntimeAdapterCreator;
  private readonly settings?: Partial<Pick<ReturnType<typeof getSettingsManager>, 'get'>>;
  private readonly spawnWorkerGateway?: CliSpawnGatewayPort;
  private readonly hasInjectedCreateAdapter: boolean;

  constructor(deps: ProviderRuntimeServiceDeps = {}) {
    this.registry = deps.registry ?? getProviderRuntimeRegistry();
    this.hasInjectedCreateAdapter = Boolean(deps.createAdapter);
    this.createAdapterFn = deps.createAdapter
      ?? ((input) => createCliAdapter(input.cliType, input.options, input.executionLocation));
    this.settings = deps.settings;
    this.spawnWorkerGateway = deps.spawnWorkerGateway;
  }

  createAdapter(input: ProviderRuntimeStartInput): CliAdapter {
    try {
      const adapter = this.shouldUseSpawnWorker(input)
        ? this.createSpawnWorkerProxy(input)
        : this.createAdapterFn(input);
      this.registry.recordAvailable({
        provider: input.cliType,
        runtime: runtimeDescriptorForSpawn(
          input.cliType,
          input.options.workingDirectory,
          input.executionLocation,
        ),
        capabilities: this.getCapabilities(adapter),
        model: input.options.model,
        source: 'adapter-created',
      });
      return adapter;
    } catch (error) {
      this.registry.recordUnavailable({
        provider: input.cliType,
        runtime: runtimeDescriptorForSpawn(
          input.cliType,
          input.options.workingDirectory,
          input.executionLocation,
        ),
        message: error instanceof Error ? error.message : String(error),
        source: 'adapter-create-failed',
      });
      throw error;
    }
  }

  private shouldUseSpawnWorker(input: ProviderRuntimeStartInput): boolean {
    if (this.readSpawnWorkerSetting() !== true) {
      return false;
    }
    if (input.executionLocation?.type === 'remote') {
      return false;
    }
    if (input.options.launchMode === 'interactive') {
      return false;
    }
    return input.cliType === 'claude' || input.cliType === 'gemini';
  }

  private readSpawnWorkerSetting(): boolean {
    try {
      if (!this.settings && this.hasInjectedCreateAdapter) {
        return false;
      }
      const settings = this.settings ?? getSettingsManager();
      return settings.get?.('enableSpawnWorkerOffload' as keyof AppSettings) === true;
    } catch {
      return false;
    }
  }

  private createSpawnWorkerProxy(input: ProviderRuntimeStartInput): CliAdapter {
    if (input.cliType !== 'claude' && input.cliType !== 'gemini') {
      return this.createAdapterFn(input);
    }
    return new CliAdapterWorkerProxy({
      cliType: input.cliType,
      instanceId: input.options.instanceId ?? `${input.cliType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      options: input.options,
      gateway: this.spawnWorkerGateway ?? getCliSpawnWorkerGateway(),
    }) as CliAdapter;
  }

  getCapabilities(adapter?: CliAdapter): AdapterRuntimeCapabilities {
    return adapter?.getRuntimeCapabilities?.() ?? DEFAULT_RUNTIME_CAPABILITIES;
  }

  interruptTurn(adapter: CliAdapter): InterruptResult {
    return adapter.interrupt();
  }

  getResumeProof(adapter?: CliAdapter): ResumeAttemptResult | undefined {
    const candidate = adapter as
      | { getResumeAttemptResult?: () => ResumeAttemptResult | undefined }
      | undefined;
    return candidate?.getResumeAttemptResult?.();
  }
}

let providerRuntimeService: ProviderRuntimeService | null = null;

export function getProviderRuntimeService(): ProviderRuntimeService {
  providerRuntimeService ??= new ProviderRuntimeService();
  return providerRuntimeService;
}

export function _resetProviderRuntimeServiceForTesting(): void {
  providerRuntimeService = null;
}
