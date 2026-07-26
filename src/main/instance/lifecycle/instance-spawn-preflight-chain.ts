import type {
  CliAdapter,
  UnifiedSpawnOptions,
} from '../../cli/adapters/adapter-factory';
import type { CliType } from '../../cli/cli-detection';
import type {
  Instance,
  InstanceCreateConfig,
} from '../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import { requiresFreshConfiguredModelSpawn } from './create-validation-helpers';
import { resolveSpawnReasoningEffort } from './reasoning-effort-resolution';
import { resolveExecutionLocation } from './execution-location-resolver';

export interface InstanceSpawnPreflightDeps {
  consumeWarmAdapter: (provider: CliType, workingDirectory: string) => CliAdapter | null;
  assertLocalModelRuntimeAvailable: (
    target: InstanceCreateConfig['modelRuntimeTarget'],
  ) => Promise<void>;
  warmCodememWorkspace: (workingDirectory: string) => Promise<void>;
}

export interface InstanceSpawnPreflightInput {
  config: InstanceCreateConfig;
  instance: Pick<Instance, 'workingDirectory' | 'bareMode'>;
  provider: CliType;
  spawnOptions: UnifiedSpawnOptions;
}

export type InstanceSpawnPreflightResult =
  | { kind: 'warm'; adapter: CliAdapter }
  | {
      kind: 'fresh';
      executionLocation: ExecutionLocation;
      spawnOptions: UnifiedSpawnOptions;
    };

/**
 * Runs the create-time checks and preparation that must happen before an
 * adapter is registered. It intentionally does not create or spawn adapters.
 */
export class InstanceSpawnPreflightChain {
  constructor(private readonly deps: InstanceSpawnPreflightDeps) {}

  async prepare(input: InstanceSpawnPreflightInput): Promise<InstanceSpawnPreflightResult> {
    const { config, instance, provider, spawnOptions } = input;
    const needsFreshConfiguredModel = requiresFreshConfiguredModelSpawn(
      provider,
      spawnOptions.model,
    );
    // A warm adapter was spawned ahead of time with the app-level default
    // effort (see `WarmStartManager` wiring in instance-manager). Its spawn
    // options are already baked in, so any create that resolved to a different
    // effort — an explicit picker level, or the "let the provider decide"
    // sentinel — must spawn fresh instead of silently inheriting the default.
    const warmEffortMismatch =
      spawnOptions.reasoningEffort !== resolveSpawnReasoningEffort({}, provider);
    const warmStartBlocked = Boolean(
      config.resume
      || config.forceNodeId
      || config.nodePlacement
      || config.modelRuntimeTarget
      || spawnOptions.browserGatewayMcp
      || needsFreshConfiguredModel
      || warmEffortMismatch
      || instance.bareMode === true,
    );

    if (!warmStartBlocked) {
      const adapter = this.deps.consumeWarmAdapter(provider, instance.workingDirectory);
      if (adapter) {
        return { kind: 'warm', adapter };
      }
    }

    const executionLocation = resolveExecutionLocation(config);
    await this.deps.assertLocalModelRuntimeAvailable(config.modelRuntimeTarget);

    if (executionLocation.type === 'remote') {
      return {
        kind: 'fresh',
        executionLocation,
        spawnOptions: {
          ...spawnOptions,
          mcpConfig: [],
          browserGatewayMcp: undefined,
        },
      };
    }

    await this.deps.warmCodememWorkspace(instance.workingDirectory);
    return { kind: 'fresh', executionLocation, spawnOptions };
  }
}
