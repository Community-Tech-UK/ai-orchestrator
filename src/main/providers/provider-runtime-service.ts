import {
  createCliAdapter,
  type CliAdapter,
  type UnifiedSpawnOptions,
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import type {
  AdapterRuntimeCapabilities,
  InterruptResult,
  ResumeAttemptResult,
} from '../cli/adapters/base-cli-adapter';
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

  constructor(deps: ProviderRuntimeServiceDeps = {}) {
    this.registry = deps.registry ?? getProviderRuntimeRegistry();
    this.createAdapterFn = deps.createAdapter
      ?? ((input) => createCliAdapter(input.cliType, input.options, input.executionLocation));
  }

  createAdapter(input: ProviderRuntimeStartInput): CliAdapter {
    try {
      const adapter = this.createAdapterFn(input);
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
