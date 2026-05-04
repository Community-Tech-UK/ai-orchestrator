/**
 * DeferredPermissionHandler — Resumes a CLI session after deferred tool-use approval/denial.
 *
 * Extracted from instance-lifecycle.ts to isolate the deferred-permission
 * resume flow (mutex acquire → terminate old adapter → write decision →
 * respawn with --resume → health check).
 *
 * Not a singleton — accepts dependencies via constructor injection.
 */

import type { Instance, InstanceStatus, ContextUsage } from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { ClaudeCliAdapter } from '../../cli/adapters/claude-cli-adapter';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { BrowserGatewayMcpConfigOptions } from '../../browser-gateway/browser-mcp-config';
import { getLogger } from '../../logging/logger';
import { planSessionRecovery } from './session-recovery';

const logger = getLogger('DeferredPermissionHandler');

/** Narrow interface for the subset of lifecycle/deps operations this handler needs. */
export interface DeferredPermissionDeps {
  getInstance: (id: string) => Instance | undefined;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  deleteDiffTracker?: (id: string) => void;
  setDiffTracker?: (id: string, tracker: unknown) => void;
  setupAdapterEvents: (instanceId: string, adapter: CliAdapter) => void;
  queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage) => void;
}

/** Narrow interface for lifecycle-internal operations the handler delegates back. */
export interface DeferredPermissionLifecycleOps {
  transitionState: (instance: Instance, newState: InstanceStatus) => void;
  resolveCliTypeForInstance: (instance: Instance) => Promise<string>;
  getMcpConfig: (
    executionLocation?: ExecutionLocation,
    instanceId?: string,
    provider?: string,
  ) => string[];
  getBrowserGatewayMcpOptions?: (
    executionLocation?: ExecutionLocation,
    instanceId?: string,
    provider?: string,
  ) => BrowserGatewayMcpConfigOptions | null;
  getPermissionHookPath: (yoloMode: boolean) => string | undefined;
  waitForResumeHealth: (instanceId: string) => Promise<boolean>;
  createCliAdapter: (cliType: string, options: UnifiedSpawnOptions, executionLocation?: ExecutionLocation) => CliAdapter;
  acquireSessionMutex: (instanceId: string, label: string) => Promise<() => void>;
}

/** External services injected for the decision-writing step. */
export interface DeferredPermissionServices {
  writeDecision: (toolUseId: string, decision: 'allow' | 'deny', reason: string) => void;
  getDecisionDir: () => string;
  createDiffTracker: (workingDirectory: string) => unknown;
}

export class DeferredPermissionHandler {
  constructor(
    private readonly deps: DeferredPermissionDeps,
    private readonly ops: DeferredPermissionLifecycleOps,
    private readonly services: DeferredPermissionServices,
  ) {}

  /**
   * Resume a Claude CLI session after the user approves or denies a deferred tool use.
   *
   * Flow:
   * 1. Write the user's decision to a file keyed by tool_use_id
   * 2. Terminate the old (exited) adapter
   * 3. Spawn a new adapter with --resume pointing to the same session
   * 4. The hook is re-invoked, reads the decision file, returns allow/deny
   * 5. Claude CLI continues or receives a denial tool_result
   */
  async resumeAfterDeferredPermission(
    instanceId: string,
    approved: boolean,
  ): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await this.ops.acquireSessionMutex(instanceId, 'resume-deferred-permission');
    try {
      const oldAdapter = this.deps.getAdapter(instanceId);
      if (!oldAdapter) {
        throw new Error(`No adapter for instance ${instanceId}`);
      }

      // Get deferred tool use from the Claude adapter
      const claudeAdapter = oldAdapter as unknown as ClaudeCliAdapter;
      const deferred = typeof claudeAdapter.getDeferredToolUse === 'function'
        ? claudeAdapter.getDeferredToolUse()
        : null;

      if (!deferred) {
        throw new Error(`No deferred tool use pending for instance ${instanceId}`);
      }

      logger.info('Resuming after deferred permission', {
        instanceId,
        approved,
        toolName: deferred.toolName,
        toolUseId: deferred.toolUseId,
        sessionId: deferred.sessionId,
      });

      const capabilities = oldAdapter.getRuntimeCapabilities();
      const recoveryPlan = planSessionRecovery({
        instanceId,
        reason: 'deferred-permission',
        previousAdapterId: oldAdapter.getName(),
        previousProviderSessionId: deferred.sessionId,
        provider: instance.provider,
        model: instance.currentModel,
        agent: instance.agentId,
        cwd: instance.workingDirectory,
        yolo: instance.yoloMode,
        executionLocation: instance.executionLocation.type,
        capabilities,
        activeTurnId: instance.activeTurnId,
        adapterGeneration: instance.adapterGeneration ?? 0,
        hasConversation: instance.outputBuffer.some(
          (message) => message.type === 'user' || message.type === 'assistant',
        ),
        sessionResumeBlacklisted: instance.sessionResumeBlacklisted === true,
        allowFreshWithoutConversation: false,
        replayUnsafeReason: capabilities.supportsResume
          ? undefined
          : 'deferred permission recovery requires a provider-native resumed turn',
      });
      if (recoveryPlan.kind !== 'native-resume' && recoveryPlan.kind !== 'provider-fork') {
        throw new Error(`Deferred permission recovery cannot continue: ${recoveryPlan.kind === 'failed' ? recoveryPlan.reason : recoveryPlan.reason}`);
      }

      // 1. Write decision file for the hook to read on resume
      this.services.writeDecision(
        deferred.toolUseId,
        approved ? 'allow' : 'deny',
        approved ? 'User approved via orchestrator UI' : 'User denied via orchestrator UI',
      );

      // 2. Terminate old adapter (process already exited, but clean up state)
      this.ops.transitionState(instance, 'respawning');
      await oldAdapter.terminate(true).catch(() => { /* already exited */ });
      this.deps.deleteAdapter(instanceId);
      this.deps.deleteDiffTracker?.(instanceId);

      // 3. Build spawn options with resume
      const cliType = await this.ops.resolveCliTypeForInstance(instance);
      const spawnOptions: UnifiedSpawnOptions = {
        instanceId: instance.id,
        sessionId: deferred.sessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: true,
        mcpConfig: this.ops.getMcpConfig(instance.executionLocation, instance.id, cliType),
        browserGatewayMcp: this.ops.getBrowserGatewayMcpOptions?.(
          instance.executionLocation,
          instance.id,
          cliType,
        ) ?? undefined,
        permissionHookPath: this.ops.getPermissionHookPath(instance.yoloMode),
      };

      // 4. Create and spawn new adapter
      const adapter = this.ops.createCliAdapter(cliType, spawnOptions, instance.executionLocation);

      // Inject the decision directory into the adapter's environment so the hook
      // can find the decision file.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).config.env = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...((adapter as any).config.env || {}),
        ORCHESTRATOR_DECISION_DIR: this.services.getDecisionDir(),
      };

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);
      if (this.deps.setDiffTracker) {
        this.deps.setDiffTracker(instanceId, this.services.createDiffTracker(instance.workingDirectory));
      }

      try {
        const pid = await adapter.spawn();
        instance.processId = pid;
        instance.sessionId = deferred.sessionId;

        const resumeHealthy = await this.ops.waitForResumeHealth(instanceId);
        if (!resumeHealthy) {
          throw new Error('Native resume did not stabilize after deferred permission');
        }

        this.ops.transitionState(instance, 'idle');
        logger.info('Resumed after deferred permission successfully', {
          instanceId,
          pid,
          approved,
          toolName: deferred.toolName,
        });
      } catch (error) {
        this.ops.transitionState(instance, 'error');
        logger.error(
          'Failed to resume after deferred permission',
          error instanceof Error ? error : undefined,
          { instanceId, approved },
        );
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
    } finally {
      release();
    }
  }
}
