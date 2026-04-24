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

const DEFAULT_RUNTIME_CAPABILITIES: AdapterRuntimeCapabilities = {
  supportsResume: false,
  supportsForkSession: false,
  supportsNativeCompaction: false,
  supportsPermissionPrompts: false,
  supportsDeferPermission: false,
};

export class ProviderRuntimeService implements ProviderRuntimeContract {
  createAdapter(input: ProviderRuntimeStartInput): CliAdapter {
    return createCliAdapter(input.cliType, input.options, input.executionLocation);
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
