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
import { attachCopilotRoute } from './copilot-route-preflight';

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
    // A warm adapter was spawned with whatever Copilot profile was current at
    // warm time; reusing it for a session that resolves to a different account
    // would send this workspace's prompts through the wrong GitHub identity.
    // Cheap and unconditional: any Copilot create spawns fresh and routes.
    const copilotRouteRequired = provider === 'copilot';
    // Warm adapters are spawned without yolo permissions. Those permissions
    // are launch-scoped, so reusing one for a yolo create would leave the
    // instance metadata saying yolo=true while the CLI still requests approval.
    const warmYoloMismatch = spawnOptions.yoloMode === true;
    const warmStartBlocked = Boolean(
      config.resume
      || config.forceNodeId
      || config.nodePlacement
      || config.modelRuntimeTarget
      || spawnOptions.browserGatewayMcp
      || needsFreshConfiguredModel
      || warmEffortMismatch
      || warmYoloMismatch
      || copilotRouteRequired
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

    // Copilot account resolution happens here, before adapter construction:
    // the factory is synchronous and routing needs git/fs I/O. Covers
    // interactive creation, respawn, and automations — every path that
    // reaches instance creation. Throws `CopilotRoutingError` when no account
    // can be resolved or verified, which the caller surfaces as an actionable
    // state rather than a generic "Copilot unavailable".
    const routedSpawnOptions = await attachCopilotRoute(
      provider,
      spawnOptions,
      config.metadata?.['automationId'] ? 'automation' : 'interactive',
      {
        explicitProfileId: config.copilotAccountProfileId,
        confirmProtectedOverride: config.copilotConfirmProtectedOverride,
        // A resume/restore keeps the profile the session was created under.
        persistedProfileId: config.resume ? config.copilotAccountProfileId : undefined,
        executionNodeId:
          executionLocation.type === 'remote' ? executionLocation.nodeId : undefined,
      },
    );

    if (executionLocation.type === 'remote') {
      return {
        kind: 'fresh',
        executionLocation,
        spawnOptions: {
          ...routedSpawnOptions,
          mcpConfig: [],
          browserGatewayMcp: undefined,
        },
      };
    }

    await this.deps.warmCodememWorkspace(instance.workingDirectory);
    return { kind: 'fresh', executionLocation, spawnOptions: routedSpawnOptions };
  }
}
