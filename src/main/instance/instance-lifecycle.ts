/**
 * Instance Lifecycle Manager - Create, terminate, restart, and mode management
 */

import { EventEmitter } from 'events';
import { app } from 'electron';
import { existsSync } from 'fs';
import * as path from 'path';
import {
  createCliAdapter,
  resolveCliType,
  getCliDisplayName,
  type UnifiedSpawnOptions,
  type CliAdapter
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import type { AdapterRuntimeCapabilities } from '../cli/adapters/base-cli-adapter';
import { RemoteCliAdapter } from '../cli/adapters/remote-cli-adapter';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import {
  getDefaultModelForCli,
  getModelsForProvider,
  getProviderModelContextWindow,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier
} from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager } from '../history';
import { getMemoryMonitor, getOutputStorageManager } from '../memory';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import { getCodebaseMiner } from '../memory/codebase-miner';
import { getConversationMiner } from '../memory/conversation-miner';
import { getSupervisorTree } from '../process';
import { getDefaultAgent, getAgentById } from '../../shared/types/agent.types';
import { getAgentRegistry } from '../agents/agent-registry';
import { getPermissionManager } from '../security/permission-manager';
import { getDisallowedTools } from '../../shared/utils/permission-mapper';
import { generateId, generateInstanceId, type InstanceProvider, INSTANCE_ID_PREFIXES } from '../../shared/utils/id-generator';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import { LIMITS } from '../../shared/constants/limits';
import {
  createDefaultContextInheritance,
  type ContextInheritanceConfig,
  type TerminationPolicy,
} from '../../shared/types/supervision.types';
import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  ContextUsage,
  OutputMessage,
  SessionDiffStats
} from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import type { CoreDeps } from './instance-deps';
import { getPolicyAdapter } from '../observation/policy-adapter';
import { resolveInstructionStack } from '../core/config/instruction-resolver';
import { getHibernationManager } from '../process/hibernation-manager';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getSessionMutex } from '../session/session-mutex';
import { RecoveryRecipeEngine } from '../session/recovery-recipe-engine';
import { createBuiltinRecipes } from '../session/builtin-recovery-recipes';
import { getCheckpointManager } from '../session/checkpoint-manager';
import type { DetectedFailure } from '../../shared/types/recovery.types';
import { WarmStartManager } from './warm-start-manager';
import { SessionDiffTracker } from './session-diff-tracker';
import {
  IllegalTransitionError,
  InstanceStateMachine,
} from './instance-state-machine';
import { getAutoTitleService } from './auto-title-service';
import { ToolListFilter } from '../tools/tool-list-filter';
import type { DenyRule } from '../tools/tool-list-filter';
import { ActivityStateDetector } from '../providers/activity-state-detector';
import { ensureHookScript } from '../cli/hooks/hook-path-resolver';
import { getDeferDecisionStore } from '../cli/hooks/defer-decision-store';
import { InstanceSpawner } from './lifecycle/instance-spawner';
import { DeferredPermissionHandler } from './lifecycle/deferred-permission-handler';
import { PlanModeManager } from './lifecycle/plan-mode-manager';
import { RestartPolicyHelpers } from './lifecycle/restart-policy-helpers';
import { SessionRecoveryHandler, type RecoveryResult } from './lifecycle/session-recovery';
import { IdleMonitor } from './lifecycle/idle-monitor';
import { InterruptRespawnHandler } from './lifecycle/interrupt-respawn-handler';
import { getCompactionCoordinator } from '../context/compaction-coordinator';
import { getCodemem } from '../codemem';
import { buildCodememMcpConfig } from '../codemem/mcp-config';
import { warmCodememWithTimeout } from './warm-codemem';

const logger = getLogger('InstanceLifecycle');
const LOG_PREVIEW_LENGTH = 160;

// Tools that require Claude CLI's interactive terminal and auto-deny in --print mode.
// Always disallow these so Claude doesn't attempt them and misinterpret the auto-denial
// as user rejection. Claude will ask questions as regular text messages instead.
const PRINT_MODE_INCOMPATIBLE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

function summarizeLogText(value: string | undefined, maxLength = LOG_PREVIEW_LENGTH): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

function summarizeAttachments(
  attachments: InstanceCreateConfig['attachments']
): Record<string, unknown>[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    name: summarizeLogText(attachment.name, 80) ?? attachment.name,
    type: attachment.type,
    size: attachment.size,
    dataLength: attachment.data.length,
  }));
}

function summarizeInitialOutputBuffer(
  outputBuffer: OutputMessage[] | undefined
): Record<string, unknown> | undefined {
  if (!outputBuffer || outputBuffer.length === 0) {
    return undefined;
  }

  const totalContentLength = outputBuffer.reduce((total, message) => total + message.content.length, 0);
  const totalAttachmentCount = outputBuffer.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0
  );

  return {
    count: outputBuffer.length,
    totalContentLength,
    totalAttachmentCount,
    recentMessages: outputBuffer.slice(-3).map((message) => ({
      type: message.type,
      contentLength: message.content.length,
      attachmentCount: message.attachments?.length ?? 0,
      metadataKeys: message.metadata ? Object.keys(message.metadata).slice(0, 8) : undefined,
    })),
  };
}

function summarizeCreateInstanceConfig(config: InstanceCreateConfig): Record<string, unknown> {
  return {
    displayName: config.displayName,
    parentId: config.parentId,
    historyThreadId: config.historyThreadId,
    sessionId: config.sessionId,
    resume: config.resume ?? false,
    workingDirectory: config.workingDirectory,
    initialPromptLength: config.initialPrompt?.length ?? 0,
    initialPromptPreview: summarizeLogText(config.initialPrompt),
    attachments: summarizeAttachments(config.attachments),
    yoloMode: config.yoloMode,
    initialOutputBuffer: summarizeInitialOutputBuffer(config.initialOutputBuffer),
    agentId: config.agentId,
    modelOverride: config.modelOverride,
    provider: config.provider,
    terminationPolicy: config.terminationPolicy,
    hasContextInheritanceOverride: Boolean(config.contextInheritance),
    forceNodeId: config.forceNodeId ?? null,
    hasNodePlacement: Boolean(config.nodePlacement),
  };
}

/**
 * Dependencies required by the lifecycle manager
 */
export interface LifecycleDependencies {
  getInstance: (id: string) => Instance | undefined;
  setInstance: (instance: Instance) => void;
  deleteInstance: (id: string) => boolean;
  getAdapter: (id: string) => CliAdapter | undefined;
  setAdapter: (id: string, adapter: CliAdapter) => void;
  deleteAdapter: (id: string) => boolean;
  getInstanceCount: () => number;
  forEachInstance: (callback: (instance: Instance, id: string) => void) => void;
  queueUpdate: (
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: import('../../shared/types/ipc.types').ErrorInfo,
    executionLocation?: ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    },
    activityState?: import('../../shared/types/activity.types').ActivityState,
  ) => void;
  serializeForIpc: (instance: Instance) => Record<string, unknown>;
  setupAdapterEvents: (instanceId: string, adapter: CliAdapter) => void;
  initializeRlm: (instance: Instance) => Promise<void>;
  endRlmSession: (instanceId: string) => void;
  ingestInitialOutputToRlm: (instance: Instance, messages: OutputMessage[]) => Promise<void>;
  registerOrchestration: (instanceId: string, workingDirectory: string, parentId: string | null) => void;
  unregisterOrchestration: (instanceId: string) => void;
  markInterrupted: (instanceId: string) => void;
  clearInterrupted: (instanceId: string) => void;
  addToOutputBuffer: (instance: Instance, message: OutputMessage) => void;
  clearFirstMessageTracking: (instanceId: string) => void;
  markFirstMessageReceived: (instanceId: string) => void;
  clearPendingState?: (instanceId: string) => void;
  /** Optional warm-start manager for pre-spawned adapter reuse. */
  warmStartManager?: WarmStartManager;
  /** Optional: store a SessionDiffTracker for the given instance. */
  setDiffTracker?: (id: string, tracker: SessionDiffTracker) => void;
  /** Optional: remove the SessionDiffTracker for the given instance. */
  deleteDiffTracker?: (id: string) => void;
  startStuckTracking?: (instanceId: string) => void;
  stopStuckTracking?: (instanceId: string) => void;
  /** State machine accessors for soft-validated lifecycle transitions. */
  getStateMachine?: (instanceId: string) => InstanceStateMachine | undefined;
  setStateMachine?: (instanceId: string, machine: InstanceStateMachine) => void;
  deleteStateMachine?: (instanceId: string) => void;
  /**
   * Narrow dependency interfaces for the core execution loop.
   * When provided, lifecycle methods should prefer these over direct singleton access.
   * Optional for backward compatibility — existing code paths continue to work.
   */
  coreDeps?: CoreDeps;
}

// MCP config file for spawned CLI instances (LSP server, etc.)
// In packaged app: extraResources places config/ in Contents/Resources/config/
// In dev mode: config/ is at project root, 3 levels up from dist/main/instance/
const MCP_CONFIG_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'config', 'mcp-servers.json')
  : path.resolve(__dirname, '../../../config/mcp-servers.json');

export class InstanceLifecycleManager extends EventEmitter {
  private settings = getSettingsManager();
  private memoryMonitor = getMemoryMonitor();
  private outputStorage = getOutputStorageManager();
  private deps: LifecycleDependencies;
  private activityDetectors = new Map<string, ActivityStateDetector>();
  private recoveryEngine: RecoveryRecipeEngine | null = null;

  /** Extracted idle-monitoring loop (periodic activity poll + zombie cleanup). */
  private readonly idleMonitor: IdleMonitor;

  /** Extracted interrupt + post-interrupt/unexpected-exit respawn flows. */
  private readonly interruptRespawn: InterruptRespawnHandler;

  /**
   * Focused spawner for isolated CLI process spawn operations (e.g. test harnesses,
   * future simplified spawn flows). The existing createInstance() method handles
   * the full production lifecycle and is not delegated here.
   */
  readonly spawner: InstanceSpawner;

  /** Extracted plan-mode state machine. */
  readonly planMode: PlanModeManager;

  /** Extracted deferred-permission resume flow. */
  private readonly deferredPermission: DeferredPermissionHandler;

  /** Extracted restart/respawn policy helpers. */
  readonly restartHelpers: RestartPolicyHelpers;

  private getRecoveryEngine(): RecoveryRecipeEngine {
    if (!this.recoveryEngine) {
      this.recoveryEngine = new RecoveryRecipeEngine(
        getCheckpointManager(),
        getSessionContinuityManager(),
      );
      for (const recipe of createBuiltinRecipes()) {
        this.recoveryEngine.registerRecipe(recipe);
      }
    }
    return this.recoveryEngine;
  }

  /** Returns MCP config paths to pass to spawned CLI instances.
   *  Returns empty for remote instances — local filesystem paths don't exist on the worker. */
  private getMcpConfig(executionLocation?: ExecutionLocation): string[] {
    // MCP config paths are local filesystem paths. Remote workers have their
    // own MCP config on their filesystem; passing ours would cause invalid
    // --mcp-config arguments that may crash the CLI on the worker.
    if (executionLocation?.type === 'remote') {
      return [];
    }
    const configs: string[] = [];
    try {
      if (existsSync(MCP_CONFIG_PATH)) {
        logger.info('MCP config found', { path: MCP_CONFIG_PATH });
        configs.push(MCP_CONFIG_PATH);
      }
    } catch (err) {
      logger.error('Failed to check MCP config', err instanceof Error ? err : new Error(String(err)), {
        path: MCP_CONFIG_PATH,
      });
    }

    if (this.settings.getAll().codememEnabled) {
      const codememConfig = buildCodememMcpConfig({
        currentDir: __dirname,
        dbPath: path.join(app.getPath('userData'), 'codemem.sqlite'),
        execPath: process.execPath,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      });

      if (codememConfig) {
        configs.push(codememConfig);
      } else {
        logger.warn('Codemem MCP bridge entrypoint not found — child sessions will not expose mcp__codemem__* tools', {
          currentDir: __dirname,
          isPackaged: app.isPackaged,
        });
      }
    }

    if (configs.length === 0) {
      logger.warn('No MCP configs resolved — spawned instances will not have custom MCP servers', {
        expectedPath: MCP_CONFIG_PATH,
        isPackaged: app.isPackaged,
      });
    }

    return configs;
  }

  /** Returns the defer permission hook path for non-YOLO instances, undefined for YOLO.
   *  The hook intercepts dangerous tools (Bash, etc.) and returns `defer` so the
   *  orchestrator can surface approval UI instead of silently denying. */
  private getPermissionHookPath(yoloMode: boolean): string | undefined {
    if (yoloMode) return undefined;
    try {
      return ensureHookScript();
    } catch (err) {
      logger.warn('Failed to resolve defer permission hook path, skipping', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  private async warmCodememWorkspace(workspacePath: string): Promise<void> {
    // Hard cap the time we're willing to block the spawn critical path on
    // codemem warm-up. On large workspaces or when the main process event
    // loop is already saturated (e.g. several restored instances streaming
    // output in parallel after a history restore), `warmWorkspace` can take
    // arbitrarily long. Previously this could delay `adapter.spawn()` by
    // minutes. Cap it: whatever hasn't finished in time just continues in
    // the background without blocking the spawn.
    await warmCodememWithTimeout(getCodemem(), {
      workspacePath,
      timeoutMs: 2500,
      logger,
    });
  }

  /**
   * Determine where an instance should execute based on its creation config.
   * Returns { type: 'local' } by default. Only returns remote if:
   * 1. A specific node is forced via forceNodeId, OR
   * 2. Placement preferences match an available remote node
   */
  private resolveExecutionLocation(config: InstanceCreateConfig): ExecutionLocation {
    // 1. Explicit node override
    if (config.forceNodeId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWorkerNodeRegistry } = require('../remote-node');
        const registry = getWorkerNodeRegistry();
        const node = registry.getNode(config.forceNodeId);
        // Accept both 'connected' and 'degraded' — the UI allows selecting
        // degraded nodes. Silently falling through to local when the user
        // explicitly chose a remote node causes confusing spawn failures
        // (e.g., local Claude CLI tries to use a remote CWD).
        if (node?.status === 'connected' || node?.status === 'degraded') {
          logger.info('Resolved execution location', {
            type: 'remote',
            reason: 'forceNodeId',
            nodeId: config.forceNodeId,
            nodeStatus: node.status,
          });
          return { type: 'remote', nodeId: config.forceNodeId };
        }
        if (config.forceNodeId) {
          logger.warn('Forced nodeId not reachable — falling through to local', {
            nodeId: config.forceNodeId,
            nodeStatus: node?.status ?? 'not-found',
          });
        }
      } catch (err) {
        // Remote node module not available — fall through to local
        logger.warn('Remote node module unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }

    // 2. Placement preferences
    if (config.nodePlacement) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getWorkerNodeRegistry } = require('../remote-node');
        const registry = getWorkerNodeRegistry();
        const node = registry.selectNode(config.nodePlacement);
        if (node) {
          logger.info('Resolved execution location', {
            type: 'remote',
            reason: 'nodePlacement',
            nodeId: node.id,
          });
          return { type: 'remote', nodeId: node.id };
        }
      } catch {
        // Remote node module not available — fall through to local
      }
    }

    // 3. Default: local
    logger.info('Resolved execution location', {
      type: 'local',
      forceNodeId: config.forceNodeId ?? null,
      hasNodePlacement: Boolean(config.nodePlacement),
    });
    return { type: 'local' };
  }

  constructor(deps: LifecycleDependencies) {
    super();
    this.deps = deps;
    this.spawner = new InstanceSpawner({
      createAdapter: async (config) => {
        const adapter = createCliAdapter(config.provider as never, {
          sessionId: config.sessionId,
          workingDirectory: config.workingDirectory,
          model: config.model,
          yoloMode: config.yoloMode,
        });
        return adapter as unknown as import('./lifecycle/instance-spawner').CliAdapter;
      },
    });
    this.planMode = new PlanModeManager(
      { getInstance: deps.getInstance },
      this,
    );
    this.deferredPermission = new DeferredPermissionHandler(
      {
        getInstance: deps.getInstance,
        getAdapter: deps.getAdapter,
        setAdapter: deps.setAdapter,
        deleteAdapter: deps.deleteAdapter,
        deleteDiffTracker: deps.deleteDiffTracker,
        setDiffTracker: deps.setDiffTracker as ((id: string, tracker: unknown) => void) | undefined,
        setupAdapterEvents: deps.setupAdapterEvents,
        queueUpdate: deps.queueUpdate,
      },
      {
        transitionState: (instance, newState) => this.transitionState(instance, newState),
        resolveCliTypeForInstance: (instance) => this.resolveCliTypeForInstance(instance) as Promise<string>,
        getMcpConfig: (loc) => this.getMcpConfig(loc),
        getPermissionHookPath: (yolo) => this.getPermissionHookPath(yolo),
        waitForResumeHealth: (id) => this.waitForResumeHealth(id),
        createCliAdapter: (cliType, options, loc) => createCliAdapter(cliType as never, options, loc),
        acquireSessionMutex: (id, label) => getSessionMutex().acquire(id, label),
      },
      {
        writeDecision: (toolUseId, decision, reason) =>
          getDeferDecisionStore().writeDecision(toolUseId, decision, reason),
        getDecisionDir: () => getDeferDecisionStore().getDecisionDir(),
        createDiffTracker: (workDir) => new SessionDiffTracker(workDir),
      },
    );
    this.restartHelpers = new RestartPolicyHelpers(
      {
        loadMessages: (id) => getOutputStorageManager().loadMessages(id),
        archiveInstance: (inst, status) => getHistoryManager().archiveInstance(inst, status),
        resetBudgetTracker: (id) => getCompactionCoordinator().resetBudgetTracker(id),
        clearFirstMessageTracking: (id) => deps.clearFirstMessageTracking(id),
        deleteDiffTracker: deps.deleteDiffTracker,
        setDiffTracker: deps.setDiffTracker
          ? (id, workDir) => deps.setDiffTracker!(id, new SessionDiffTracker(workDir))
          : undefined,
      },
      { getActiveMessages: (input) => this.getActiveMessages(input) },
    );
    this.idleMonitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: this.settings.getAll().autoTerminateIdleMinutes }),
      getRecoveryEngine: () => this.getRecoveryEngine(),
      getActivityDetectors: () => this.activityDetectors,
      getInstance: (id) => this.deps.getInstance(id),
      forEachInstance: (cb) => this.deps.forEachInstance(cb),
      getAdapter: (id) => this.deps.getAdapter(id),
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState),
      deleteAdapter: (id) => { this.deps.deleteAdapter(id); },
      transitionState: (instance, newState) => this.transitionState(instance, newState),
      terminateInstance: (id, auto) => this.terminateInstance(id, auto),
      hibernateInstance: (id) => this.hibernateInstance(id),
      dispatchRecovery: (instanceId, failure) => this.dispatchRecoveryActions(instanceId, failure),
    });
    this.idleMonitor.start();
    this.interruptRespawn = new InterruptRespawnHandler({
      getInstance: (id) => this.deps.getInstance(id),
      getAdapter: (id) => this.deps.getAdapter(id),
      setAdapter: (id, adapter) => this.deps.setAdapter(id, adapter),
      deleteAdapter: (id) => { this.deps.deleteAdapter(id); },
      queueUpdate: (instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState) =>
        this.deps.queueUpdate(instanceId, status, contextUsage, diffStats, displayName, error, executionLocation, sessionState, activityState),
      markInterrupted: (id) => this.deps.markInterrupted(id),
      clearInterrupted: (id) => this.deps.clearInterrupted(id),
      addToOutputBuffer: (instance, message) => this.deps.addToOutputBuffer(instance, message),
      setupAdapterEvents: (id, adapter) => this.deps.setupAdapterEvents(id, adapter),
      transitionState: (instance, newState) => this.transitionState(instance, newState),
      getAdapterRuntimeCapabilities: (adapter) => this.getAdapterRuntimeCapabilities(adapter),
      resolveCliTypeForInstance: (instance) => this.resolveCliTypeForInstance(instance),
      getMcpConfig: (loc) => this.getMcpConfig(loc),
      getPermissionHookPath: (yolo) => this.getPermissionHookPath(yolo),
      waitForResumeHealth: (id, timeoutMs) => this.waitForResumeHealth(id, timeoutMs),
      waitForAdapterWritable: (id, timeoutMs) => this.waitForAdapterWritable(id, timeoutMs),
      buildReplayContinuityMessage: (instance, reason) => this.buildReplayContinuityMessage(instance, reason),
      buildFallbackHistory: (instance, reason) => this.buildFallbackHistory(instance, reason),
      emitOutput: (instanceId, message) => { this.emit('output', { instanceId, message }); },
    });
    this.setupMemoryMonitoring();
  }

  // ============================================
  // State Machine Integration
  // ============================================

  /**
   * Public wrapper for transitionState — used by InstanceManager.updateInstanceStatus().
   *
   * The lifecycle state machine is authoritative. Illegal transitions fail
   * fast instead of mutating state behind the state machine's back.
   */
  transitionStatePublic(instance: Instance, newState: InstanceStatus): void {
    this.transitionState(instance, newState);
  }

  private transitionState(instance: Instance, newState: InstanceStatus): void {
    const previousStatus = instance.status;
    if (previousStatus === newState) {
      return;
    }

    let sm = this.deps.getStateMachine?.(instance.id);
    if (!sm) {
      sm = new InstanceStateMachine(previousStatus);
      this.deps.setStateMachine?.(instance.id, sm);
    }

    try {
      sm.transition(newState);
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        logger.error('Illegal lifecycle transition blocked', undefined, {
          instanceId: instance.id,
          from: previousStatus,
          to: newState,
        });
      }
      throw error;
    }

    instance.status = sm.current;
    this.emit('state-update', {
      instanceId: instance.id,
      status: instance.status,
      previousStatus,
      timestamp: Date.now(),
    });
  }

  private getAdapterRuntimeCapabilities(adapter?: CliAdapter): AdapterRuntimeCapabilities {
    if (adapter && 'getRuntimeCapabilities' in adapter && typeof adapter.getRuntimeCapabilities === 'function') {
      return adapter.getRuntimeCapabilities();
    }
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  private async resolveCliTypeForInstance(instance: Instance): Promise<CliType> {
    const settingsAll = this.settings.getAll();
    return resolveCliType(instance.provider, settingsAll.defaultCli);
  }

  private isSessionBoundaryMessage(message: OutputMessage): boolean {
    return (
      message.type === 'system'
      && typeof message.metadata?.['kind'] === 'string'
      && message.metadata['kind'] === 'session-boundary'
    );
  }

  private getActiveMessages(input: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>): OutputMessage[] {
    const boundaryId = input.archivedUpToMessageId;
    const boundaryIndex = boundaryId
      ? input.outputBuffer.findIndex((message) => message.id === boundaryId)
      : -1;
    const candidateMessages = boundaryIndex >= 0
      ? input.outputBuffer.slice(boundaryIndex + 1)
      : input.outputBuffer;

    return candidateMessages.filter((message) => !this.isSessionBoundaryMessage(message));
  }

  private hasActiveConversation(instance: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>): boolean {
    return this.getActiveMessages(instance).some(
      (message) => message.type === 'user' || message.type === 'assistant'
    );
  }

  private buildReplayContinuityMessage(instance: Instance, reason: string): string {
    return this.restartHelpers.buildReplayContinuityMessage(instance, reason);
  }

  /**
   * Fire-and-forget auto-title generation from the first user message.
   */
  private triggerAutoTitle(instance: Instance, message: string): void {
    getAutoTitleService().maybeGenerateTitle(
      instance.id,
      message,
      (id, title) => {
        logger.debug('Auto-title callback (lifecycle)', { id, title, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          this.deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
    ).catch(() => { /* non-critical */ });
  }

  private async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    return this.restartHelpers.buildFallbackHistory(instance, reason);
  }

  private getSeededInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
    const outputBuffer = config.initialOutputBuffer;
    if (!outputBuffer || outputBuffer.length === 0) {
      return undefined;
    }

    const lastMessage = outputBuffer[outputBuffer.length - 1];
    const expectedAttachmentCount = config.attachments?.length ?? 0;
    const actualAttachmentCount = lastMessage.attachments?.length ?? 0;

    if (
      lastMessage.type === 'user'
      && lastMessage.content === (config.initialPrompt ?? '')
      && actualAttachmentCount === expectedAttachmentCount
    ) {
      return lastMessage;
    }

    return undefined;
  }

  private createInitialUserMessage(config: InstanceCreateConfig): OutputMessage | undefined {
    const hasText = typeof config.initialPrompt === 'string' && config.initialPrompt.length > 0;
    const hasAttachments = Boolean(config.attachments?.length);

    if (!hasText && !hasAttachments) {
      return undefined;
    }

    return {
      id: generateId(),
      timestamp: Date.now(),
      type: 'user',
      content: config.initialPrompt ?? '',
      attachments: config.attachments?.map((attachment) => ({
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        data: attachment.data,
      })),
    };
  }

  /**
   * Wait until the just-spawned CLI actually proves it accepted --resume,
   * not merely that its PID is alive.
   *
   * Positive signal: the first stream-json message from the CLI (its `init`
   * system message carrying session_id). If anything flows out, the session
   * was loaded successfully.
   *
   * Negative signal: stderr surfacing a session-not-found error (Claude CLI
   * prints "No conversation found with session ID: …" and exits when
   * --resume targets a missing/unflushed session file).
   *
   * Timeout → FAIL. The previous implementation returned true on timeout
   * whenever the process happened to still be alive, which let a silently-
   * broken CLI pass the check and triggered a cascade of failed respawns.
   * Callers already handle `false` by falling back to a fresh session.
   */
  private async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200
  ): Promise<boolean> {
    const instance = this.deps.getInstance(instanceId);
    const adapter = this.deps.getAdapter(instanceId);
    if (!instance || !adapter) return false;

    const liveness = (): boolean => {
      const inst = this.deps.getInstance(instanceId);
      const ad = this.deps.getAdapter(instanceId);
      if (!inst || !ad || ad !== adapter) return false;
      return (
        inst.processId !== null &&
        inst.status !== 'error' &&
        inst.status !== 'failed' &&
        inst.status !== 'terminated'
      );
    };

    if (!liveness()) return false;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        adapter.off('output', onOutput);
        adapter.off('error', onError);
        resolve(value);
      };

      const onOutput = (): void => finish(true);

      const onError = (err: unknown): void => {
        const text = err instanceof Error ? err.message : String(err ?? '');
        if (/no conversation found/i.test(text) || /session.*not.*found/i.test(text)) {
          finish(false);
        }
      };

      const poll = setInterval(() => {
        if (!liveness()) finish(false);
      }, pollIntervalMs);

      const timer = setTimeout(() => finish(false), timeoutMs);

      adapter.on('output', onOutput);
      adapter.on('error', onError);
    });
  }

  /**
   * Wait for the CLI adapter's stdin pipe to become writable after spawn/respawn.
   * For Claude CLI adapters this polls the internal formatter; for exec-based
   * adapters (Codex, Gemini, Copilot) the spawn() return is sufficient.
   * Falls through on timeout (fail-open) so the caller can still proceed.
   */
  private async waitForAdapterWritable(
    instanceId: string,
    timeoutMs = 3000,
    pollIntervalMs = 100
  ): Promise<boolean> {
    const isWritable = (): boolean => {
      const adapter = this.deps.getAdapter(instanceId);
      if (!adapter) return false;

      // Claude CLI uses a persistent process with a stdin formatter.
      // After respawn, the new process's stdin may not be immediately writable.
      // Access the private `formatter` field via duck-typing at runtime.
      // (TS `private` compiles to a plain property — it's accessible at runtime.)
      if (adapter.getName() === 'claude-cli') {
        const formatter = (adapter as unknown as { formatter: { isWritable(): boolean } | null }).formatter;
        return formatter !== null && formatter.isWritable();
      }

      // Exec-based adapters (Codex, Gemini, Copilot) are ready once spawn() returns.
      return true;
    };

    if (isWritable()) return true;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        logger.debug('waitForAdapterWritable timed out, proceeding anyway', { instanceId });
        resolve(isWritable());
      }, timeoutMs);

      const poll = setInterval(() => {
        if (isWritable()) {
          cleanup();
          resolve(true);
        }
      }, pollIntervalMs);

      const cleanup = (): void => {
        clearTimeout(timeout);
        clearInterval(poll);
      };
    });
  }

  // ============================================
  // Instruction Prompt Loading
  // ============================================

  /**
   * Load instruction hierarchy with backward compatibility:
   * 1) ~/.orchestrator/INSTRUCTIONS.md
   * 2) ~/.claude/CLAUDE.md (legacy)
   * 3) <workDir>/.orchestrator/INSTRUCTIONS.md
   * 4) <workDir>/.claude/CLAUDE.md (legacy)
   */
  private async loadPromptHierarchy(workDir: string): Promise<string[]> {
    const resolution = await resolveInstructionStack({
      workingDirectory: workDir,
    });

    for (const source of resolution.sources) {
      logger.debug('Resolved instruction source for instance prompt', {
        path: source.path,
        label: source.label,
        loaded: source.loaded,
        applied: source.applied,
        reason: source.reason,
      });
    }

    return resolution.mergedContent
      ? resolution.mergedContent.split('\n\n---\n\n')
      : [];
  }

  // ============================================
  // Instance Creation
  // ============================================

  /**
   * Create a new instance.
   *
   * Phase 1 (synchronous, <5ms): build the instance object, register it in the
   * store and supervisor tree, then return immediately.
   *
   * Phase 2 (background async): load instructions, resolve provider/model,
   * build the system prompt, spawn the CLI adapter, and send the initial
   * prompt. `instance.readyPromise` resolves (or rejects) when Phase 2 is
   * done. `sendInput()` awaits this promise before sending any user input.
   */
  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    logger.info('Creating instance', summarizeCreateInstanceConfig(config));
    const sessionId = config.sessionId || generateId();
    const historyThreadId = config.historyThreadId || sessionId;

    // Resolve agent profile (built-in + optional markdown-defined).
    // This is async but lightweight (registry lookup); it is needed to
    // populate agentId / agentMode on the instance object before we return.
    const resolvedAgent = await getAgentRegistry().resolveAgent(
      config.workingDirectory,
      config.agentId || null
    );

    // Resolve context inheritance (merge with defaults)
    const defaultInheritance = createDefaultContextInheritance();
    const contextInheritance: ContextInheritanceConfig = {
      ...defaultInheritance,
      ...config.contextInheritance,
    };

    // Calculate depth based on parent
    let depth = 0;
    let resolvedWorkingDir = config.workingDirectory;
    let resolvedYoloMode = config.yoloMode ?? this.settings.getAll().defaultYoloMode;
    let resolvedAgentId = resolvedAgent.id;

    if (config.parentId) {
      const parent = this.deps.getInstance(config.parentId);
      if (parent) {
        depth = parent.depth + 1;

        // Apply context inheritance from parent
        if (contextInheritance.inheritWorkingDirectory && !config.workingDirectory) {
          resolvedWorkingDir = parent.workingDirectory;
        }
        if (contextInheritance.inheritYoloMode && config.yoloMode === undefined) {
          resolvedYoloMode = parent.yoloMode;
        }
        if (contextInheritance.inheritAgentSettings && !config.agentId) {
          resolvedAgentId = parent.agentId;
        }
      }
    }

    // Load project permission rules early so the first prompts can be auto-decided.
    try {
      getPermissionManager().loadProjectRules(resolvedWorkingDir);
    } catch {
      /* intentionally ignored: project rules are optional and failure should not block instance creation */
    }

    // Resolve termination policy
    const terminationPolicy: TerminationPolicy = config.terminationPolicy || 'terminate-children';

    // =========================================================================
    // Phase 1: build and register the instance object, then return immediately.
    // =========================================================================

    const abortController = new AbortController();

    // Create instance object — use provider-prefixed ID for debuggability
    const providerKey = (config.provider && config.provider in INSTANCE_ID_PREFIXES)
      ? config.provider as InstanceProvider
      : 'generic';
    const instance: Instance = {
      id: generateInstanceId(providerKey),
      displayName: config.displayName || crossPlatformBasename(resolvedWorkingDir) || `Instance ${Date.now()}`,
      createdAt: Date.now(),
      historyThreadId,

      parentId: config.parentId || null,
      childrenIds: [],
      supervisorNodeId: '',
      workerNodeId: undefined,
      depth,

      // Phase 2: Termination & Inheritance
      terminationPolicy,
      contextInheritance,

      agentId: resolvedAgentId,
      agentMode: resolvedAgent.mode,

      planMode: {
        enabled: false,
        state: 'off'
      },

      status: 'initializing',
      contextUsage: {
        used: 0,
        total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
        percentage: 0
      },
      lastActivity: Date.now(),

      processId: null,
      providerSessionId: sessionId,
      sessionId,
      restartEpoch: 0,
      workingDirectory: resolvedWorkingDir,
      yoloMode: resolvedYoloMode,
      provider: config.provider || 'auto',
      executionLocation: { type: 'local' },
      diffStats: undefined,

      outputBuffer: config.initialOutputBuffer || [],
      outputBufferMaxSize: LIMITS.OUTPUT_BUFFER_MAX_SIZE,

      communicationTokens: new Map(),
      subscribedTo: [],

      abortController,

      totalTokensUsed: 0,
      requestCount: 0,
      errorCount: 0,
      restartCount: 0
    };

    if (instance.yoloMode) {
      logger.warn('YOLO mode enabled for instance', {
        instanceId: instance.id,
        parentId: instance.parentId,
        provider: instance.provider
      });
    }

    // Store instance so UI renders immediately
    this.deps.setInstance(instance);

    // Initialize state machine for this instance (starts in 'initializing').
    this.deps.setStateMachine?.(instance.id, new InstanceStateMachine('initializing'));

    // If has parent, update parent's children list
    if (instance.parentId) {
      const parent = this.deps.getInstance(instance.parentId);
      if (parent) {
        parent.childrenIds.push(instance.id);
      }
    }

    // Register with supervisor tree
    const supervisorTree = getSupervisorTree();
    const { supervisorNodeId, workerNodeId } = supervisorTree.registerInstance(
      instance.id,
      instance.parentId,
      instance.workingDirectory,
      instance.displayName,
      instance.terminationPolicy,
      instance.contextInheritance
    );
    instance.supervisorNodeId = supervisorNodeId;
    instance.workerNodeId = workerNodeId;

    // Emit creation event immediately with 'initializing' status so the UI
    // can render the instance card without waiting for the heavy init below.
    logger.debug('Emitting instance:created event (initializing)', { instanceId: instance.id });
    this.emit('created', this.deps.serializeForIpc(instance));

    // Initial prompts never flow through InstanceManager.sendInput(), so kick
    // off title generation here before the background spawn/send pipeline.
    if (typeof config.initialPrompt === 'string' && config.initialPrompt.trim().length > 0) {
      this.triggerAutoTitle(instance, config.initialPrompt);
    }

    // =========================================================================
    // Phase 2: heavy async init runs in the background.
    // All callers that need the instance to be fully ready must await
    // instance.readyPromise (sendInput does this automatically).
    // =========================================================================

    // Attach a no-op rejection handler so that if Phase 2 fails before
    // sendInput() gets a chance to await it, we don't emit an unhandled
    // rejection. The error is still observable via sendInput().
    const backgroundInit = (async () => {
      const { signal } = abortController;
      const seededInitialUserMessage = this.getSeededInitialUserMessage(config);
      const initialUserMessage =
        seededInitialUserMessage ?? this.createInitialUserMessage(config);
      try {
        if (signal.aborted) return;

        // Initialize RLM
        await this.deps.initializeRlm(instance);

        if (signal.aborted) return;

        // Ingest initial output buffer to RLM
        if (config.initialOutputBuffer && config.initialOutputBuffer.length > 0) {
          this.deps.ingestInitialOutputToRlm(instance, config.initialOutputBuffer);
        }

        // Get disallowed tools based on agent permissions + print-mode-incompatible tools
        const disallowedTools = [...getDisallowedTools(resolvedAgent.permissions), ...PRINT_MODE_INCOMPATIBLE_TOOLS];

        // Build proactive tool filter for pre-filtering tool definitions (defense-in-depth)
        const denyRules: DenyRule[] = disallowedTools.map(tool => ({
          pattern: tool,
          type: 'blanket' as const,
        }));
        const toolFilter = new ToolListFilter(denyRules);

        // Store filter on instance for downstream consumers
        if (!instance.metadata) instance.metadata = {};
        instance.metadata['toolFilter'] = toolFilter;

        // Load instruction hierarchy (skip for child instances to reduce token overhead)
        const instructionPrompts = instance.depth === 0
          ? await this.loadPromptHierarchy(instance.workingDirectory)
          : [];

        if (signal.aborted) return;

        // Build system prompt with instruction content prepended
        let systemPrompt = resolvedAgent.systemPrompt || '';
        if (instructionPrompts.length > 0) {
          const instructionSection = instructionPrompts.join('\n\n---\n\n');
          systemPrompt = `${instructionSection}\n\n---\n\n${systemPrompt}`;
          logger.info('Prepended instruction prompts to system prompt', { count: instructionPrompts.length });
        }

        // Inject observation memory context (learned reflections from past sessions)
        try {
          const observationContext = await getPolicyAdapter().buildObservationContext(
            systemPrompt,
            instance.id,
            config.initialPrompt
          );
          if (observationContext) {
            systemPrompt = `${observationContext}\n\n---\n\n${systemPrompt}`;
            logger.info('Injected observation memory context into system prompt');
          }
        } catch (err) {
          logger.warn('Failed to inject observation context', { error: err instanceof Error ? err.message : String(err) });
        }

        // Inject wake-up context (mempalace L0 identity + L1 essential story)
        if (instance.depth === 0) {
          try {
            const wakeText = getWakeContextBuilder().getWakeUpText(instance.workingDirectory);
            if (wakeText && wakeText.trim().length > 30) {
              systemPrompt = `${wakeText}\n\n---\n\n${systemPrompt}`;
              logger.info('Injected wake-up context into system prompt', {
                tokenEstimate: Math.ceil(wakeText.length / 4),
              });
            }
          } catch (err) {
            logger.warn('Failed to inject wake context', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Trigger codebase mining for the working directory (async, fire-and-forget)
        if (instance.depth === 0 && instance.workingDirectory) {
          getCodebaseMiner().mineDirectory(instance.workingDirectory).catch((err) => {
            logger.warn('Codebase mining failed', {
              error: err instanceof Error ? err.message : String(err),
              workingDirectory: instance.workingDirectory,
            });
          });
        }

        // Append tool permission clarification to prevent models from hallucinating
        // permission issues when commands fail for unrelated reasons (test failures, etc.)
        systemPrompt += '\n\n---\n\n' +
          '[Tool Permissions] Tools available to you are pre-configured for your current mode. ' +
          'Use any tool in your tool list directly without asking the user for permission. ' +
          'If a command fails, it failed for a real reason (syntax error, test failure, missing dependency, etc.) — not because of permissions. ' +
          'Never ask the user to approve or deny tool calls. Just use tools directly.';

        if (signal.aborted) return;

        // Resolve CLI provider type
        const settingsAll = this.settings.getAll();
        logger.debug('Resolving provider', {
          requested: config.provider,
          default: settingsAll.defaultCli
        });
        const resolvedCliType = await resolveCliType(
          config.provider,
          settingsAll.defaultCli
        );

        if (signal.aborted) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CliType (cli-detection) vs CliType (settings) mismatch
        instance.provider = resolvedCliType as any;
        logger.info('Resolved CLI provider', {
          cliType: resolvedCliType,
          displayName: getCliDisplayName(resolvedCliType)
        });

        // Resolve model: explicit override > agent override > settings default
        const settingsModel = settingsAll.defaultModel;
        let resolvedModel = config.modelOverride || resolvedAgent.modelOverride || settingsModel || undefined;

        // Validate model against the target provider's supported models.
        // If the model is a tier name (fast/balanced/powerful), resolve it to a concrete ID.
        // If the model isn't recognized (e.g., a model from another provider), drop it
        // so the provider uses its own default rather than failing with ModelNotFound.
        if (resolvedModel && resolvedCliType !== 'claude') {
          // First: resolve tier names to concrete model IDs
          if (isModelTier(resolvedModel)) {
            const tierResolved = resolveModelForTier(resolvedModel, resolvedCliType);
            logger.info('Resolved model tier to provider-specific model', {
              tier: resolvedModel,
              provider: resolvedCliType,
              resolvedModel: tierResolved || 'provider-default',
            });
            resolvedModel = tierResolved;
          }

          // Then: validate concrete model IDs against the provider's model list
          if (resolvedModel) {
            const providerModels = getModelsForProvider(resolvedCliType);
            if (providerModels.length > 0) {
              const isValid = providerModels.some(m => m.id === resolvedModel);
              const allowCodexDynamicModel = resolvedCliType === 'codex' && looksLikeCodexModelId(resolvedModel);
              if (!isValid && !allowCodexDynamicModel) {
                const providerDefault = getDefaultModelForCli(resolvedCliType);
                logger.warn('Model not valid for target provider, falling back to provider default', {
                  model: resolvedModel,
                  provider: resolvedCliType,
                  validModels: providerModels.map(m => m.id),
                  fallbackModel: providerDefault ?? 'none',
                });
                resolvedModel = providerDefault;
              }
            }
          }
        }

        instance.currentModel = resolvedModel;
        instance.contextUsage = {
          ...instance.contextUsage,
          total: getProviderModelContextWindow(resolvedCliType, resolvedModel),
          percentage: 0
        };

        logger.info('Resolved model for instance', {
          configOverride: config.modelOverride,
          agentOverride: resolvedAgent.modelOverride,
          settingsDefault: settingsModel,
          resolved: resolvedModel,
        });

        // Allow all tools by default — don't pass --allowedTools unless explicitly configured.
        // Tool restrictions are handled via --disallowedTools from agent permission profiles.
        const defaultAllowedTools = undefined;

        // Create CLI adapter - use resolved model
        const modelOverride = resolvedModel;
        const spawnOptions: UnifiedSpawnOptions = {
          sessionId: instance.sessionId,
          workingDirectory: instance.workingDirectory,
          systemPrompt: systemPrompt,
          model: modelOverride,
          yoloMode: instance.yoloMode,
          allowedTools: defaultAllowedTools,
          disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
          resume: config.resume,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        };

        // Check for a pre-warmed adapter before spawning fresh.
        // NEVER use warm-start for resume operations — warm adapters have fresh sessions
        // with no conversation context. Resume requires --resume <sessionId> on a freshly
        // spawned CLI process.
        // NEVER use warm-start for remote sessions — warm adapters are local processes
        // and cannot proxy commands to a remote worker node.
        const warmAdapter = (config.resume || config.forceNodeId || config.nodePlacement)
          ? null
          : (this.deps.warmStartManager?.consume(resolvedCliType, instance.workingDirectory) as CliAdapter | null ?? null);

        let adapter: CliAdapter;
        if (warmAdapter) {
          logger.info('Using warm-start adapter (skipping spawn)', { provider: resolvedCliType, instanceId: instance.id });
          adapter = warmAdapter;

          // Set up adapter events and store the adapter.
          this.deps.setupAdapterEvents(instance.id, adapter);
          this.deps.setAdapter(instance.id, adapter);
          if (this.deps.setDiffTracker) {
            this.deps.setDiffTracker(instance.id, new SessionDiffTracker(instance.workingDirectory));
          }

          if (signal.aborted) {
            await adapter.terminate(false).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instance.id);
            return;
          }

          // The warm adapter is already spawned; mark the instance as idle.
          this.transitionState(instance, 'idle');
          this.deps.queueUpdate(instance.id, 'idle', instance.contextUsage);
          this.deps.startStuckTracking?.(instance.id);
          logger.info('Warm-start instance ready', { instanceId: instance.id });

          // Send initial prompt if provided.
          if (initialUserMessage) {
            if (!seededInitialUserMessage) {
              this.deps.addToOutputBuffer(instance, initialUserMessage);
              this.emit('output', { instanceId: instance.id, message: initialUserMessage });
            }
            try {
              await adapter.sendInput(initialUserMessage.content, config.attachments);
            } catch (error) {
              this.transitionState(instance, 'failed');
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.error('Failed to send initial prompt via warm adapter', error instanceof Error ? error : undefined, { errorMessage });
              const errorOutput = {
                id: generateId(),
                timestamp: Date.now(),
                type: 'error' as const,
                content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
              };
              this.deps.addToOutputBuffer(instance, errorOutput);
              this.emit('output', { instanceId: instance.id, message: errorOutput });
              this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
              throw error;
            }
          }
        } else {
          const executionLocation = this.resolveExecutionLocation(config);
          instance.executionLocation = executionLocation;
          // Clear local MCP config for remote instances — paths don't exist on workers
          if (executionLocation.type === 'remote') {
            spawnOptions.mcpConfig = [];
          } else {
            await this.warmCodememWorkspace(instance.workingDirectory);
          }
          adapter = createCliAdapter(resolvedCliType, spawnOptions, executionLocation);

          // Set up adapter events
          this.deps.setupAdapterEvents(instance.id, adapter);

          // Store adapter
          this.deps.setAdapter(instance.id, adapter);
          if (this.deps.setDiffTracker) {
            this.deps.setDiffTracker(instance.id, new SessionDiffTracker(instance.workingDirectory));
          }

          if (signal.aborted) {
            // Clean up the adapter we just registered
            await adapter.terminate(false).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instance.id);
            return;
          }

          // Spawn the CLI process
          try {
            logger.info('Spawning CLI process', { provider: resolvedCliType });
            const pid = await adapter.spawn();

            if (signal.aborted) {
              await adapter.terminate(false).catch(() => { /* ignore */ });
              this.deps.deleteAdapter(instance.id);
              return;
            }

            instance.processId = pid;
            // Create activity detector for this instance
            const detector = new ActivityStateDetector(
              instance.id,
              instance.workingDirectory || process.cwd(),
              instance.provider ?? 'claude-cli',
            );
            if (pid) detector.setPid(pid);
            this.activityDetectors.set(instance.id, detector);
            // Inject detector into adapter if it supports activity recording
            const adapterForDetector = this.deps.getAdapter(instance.id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setActivityDetector is not in CliAdapter interface; runtime check guards the call
            const adapterWithDetector = adapterForDetector as any;
            if (adapterForDetector && typeof adapterWithDetector.setActivityDetector === 'function') {
              adapterWithDetector.setActivityDetector(detector);
            }
            this.transitionState(instance, 'idle');
            this.deps.queueUpdate(instance.id, 'idle', instance.contextUsage, undefined, undefined, undefined, instance.executionLocation);
            this.deps.startStuckTracking?.(instance.id);
            logger.info('CLI spawned successfully', { pid, instanceId: instance.id });

            // Send initial prompt if provided
            if (initialUserMessage) {
              if (!seededInitialUserMessage) {
                this.deps.addToOutputBuffer(instance, initialUserMessage);
                this.emit('output', { instanceId: instance.id, message: initialUserMessage });
              }
              await adapter.sendInput(initialUserMessage.content, config.attachments);
            }
          } catch (error) {
            this.transitionState(instance, 'failed');
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Failed to spawn/initialize CLI', error instanceof Error ? error : undefined, { errorMessage });

            const errorOutput = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'error' as const,
              content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
            };
            this.deps.addToOutputBuffer(instance, errorOutput);
            this.emit('output', { instanceId: instance.id, message: errorOutput });
            this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
            throw error;
          }
        }

        // After a successful spawn/warm-start, pre-warm a replacement process in
        // the background for the next createInstance call of the same provider.
        // Skip this after native resume restores: the spare process only serves
        // future fresh sessions, but it still expires on a 5 minute timer while
        // the restored session is idle.
        if (this.deps.warmStartManager && !config.resume) {
          const wsm = this.deps.warmStartManager;
          const warmProvider = resolvedCliType;
          const warmWorkingDir = instance.workingDirectory;
          // Fire and forget — errors are handled inside preWarm.
          void wsm.preWarm(warmProvider, warmWorkingDir);
        } else if (this.deps.warmStartManager && config.resume) {
          logger.info('Skipping warm-start replacement after resumed session spawn', {
            provider: resolvedCliType,
            instanceId: instance.id,
            sessionId: instance.sessionId,
          });
        }

        // Register with orchestration handler
        this.deps.registerOrchestration(
          instance.id,
          instance.workingDirectory,
          instance.parentId
        );
      } catch (error) {
        if (!signal.aborted) {
          if (instance.status !== 'failed') {
            this.transitionState(instance, 'failed');
            this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
          }
          logger.error('Instance background init failed', error instanceof Error ? error : undefined, { instanceId: instance.id });
        }
        throw error;
      } finally {
        instance.readyPromise = undefined;
        instance.abortController = undefined;
      }
    })();

    // Store the promise so sendInput() can await it.
    instance.readyPromise = backgroundInit;
    // Attach a no-op catch on a separate chain so that if no one awaits
    // readyPromise before it rejects, Node doesn't emit an unhandled rejection.
    backgroundInit.catch(() => { /* rejection handled via sendInput() status check */ });

    return instance;
  }

  // ============================================
  // Instance Termination
  // ============================================

  /**
   * Terminate an instance
   */
  async terminateInstance(
    instanceId: string,
    graceful = true
  ): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    // Release any held mutex lock to prevent orphaned locks
    getSessionMutex().forceRelease(instanceId);

    // Stop stuck process tracking
    this.deps.stopStuckTracking?.(instanceId);

    // Always clean up diff tracker, even if adapter is null (e.g., spawn failed)
    this.deps.deleteDiffTracker?.(instanceId);
    this.deps.deleteStateMachine?.(instanceId);
    this.activityDetectors.delete(instanceId);
    this.recoveryEngine?.clearHistory(instanceId);

    if (adapter) {
      try {
        await adapter.terminate(graceful);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Remote adapters fail frequently when the node is disconnected — expected.
        // Local failures are more concerning and should be logged as errors.
        if (adapter instanceof RemoteCliAdapter) {
          logger.warn('Remote adapter terminate failed, proceeding with cleanup', { instanceId, error: errorMsg });
        } else {
          logger.error('Local adapter terminate failed, proceeding with cleanup', error instanceof Error ? error : undefined, { instanceId });
        }
      }
      // Force cleanup of remote adapter listeners to prevent memory leaks
      if (adapter instanceof RemoteCliAdapter) {
        adapter.forceCleanup();
      }
      this.deps.deleteAdapter(instanceId);
    }

    if (instance) {
      // Archive to history before cleanup (only for root instances with messages)
      if (!instance.parentId && instance.outputBuffer.length > 0) {
        try {
          const history = getHistoryManager();
          const status = instance.status === 'error' ? 'error' : 'completed';
          await history.archiveInstance(instance, status);
        } catch (error) {
          logger.error('Failed to archive instance to history', error instanceof Error ? error : undefined, { instanceId });
        }
      }

      // Mine transcript into verbatim storage (async, non-blocking)
      if (!instance.parentId && instance.outputBuffer.length >= 4) {
        try {
          const transcript = instance.outputBuffer
            .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
            .map((msg) => msg.type === 'user' ? `> ${msg.content}` : msg.content)
            .join('\n\n');

          if (transcript.length > 100) {
            const wing = instance.workingDirectory || 'default';
            const sourceFile = `session://${instance.id}/terminate`;
            getConversationMiner().importFromString(transcript, {
              wing,
              sourceFile,
            });
            logger.info('Mined transcript into verbatim storage', {
              instanceId,
              messageCount: instance.outputBuffer.length,
            });
          }
        } catch (error) {
          logger.warn('Failed to mine transcript', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      this.transitionState(instance, 'terminated');
      instance.processId = null;

      // Remove from parent's children list
      if (instance.parentId) {
        const parent = this.deps.getInstance(instance.parentId);
        if (parent) {
          parent.childrenIds = parent.childrenIds.filter(
            (id) => id !== instanceId
          );
        }
      }

      // Handle children based on termination policy
      const childrenToTerminate: string[] = [];
      const childrenToOrphan: string[] = [];

      switch (instance.terminationPolicy) {
        case 'terminate-children':
          // Terminate all children (default behavior)
          childrenToTerminate.push(...instance.childrenIds);
          break;

        case 'orphan-children':
          // Leave children running without parent
          childrenToOrphan.push(...instance.childrenIds);
          for (const childId of childrenToOrphan) {
            const child = this.deps.getInstance(childId);
            if (child) {
              child.parentId = null;
              logger.info('Orphaned child instance', { childId, parentId: instanceId });
            }
          }
          break;

        case 'reparent-to-root':
          // Reparent children to root (no parent)
          for (const childId of instance.childrenIds) {
            const child = this.deps.getInstance(childId);
            if (child) {
              child.parentId = null;
              child.depth = 0;
              logger.info('Reparented child instance to root', { childId, formerParentId: instanceId });
            }
          }
          break;
      }

      // Terminate children that need to be terminated
      for (const childId of childrenToTerminate) {
        await this.terminateInstance(childId, graceful);
      }

      // Clear the children list
      instance.childrenIds = [];

      // Unregister from supervisor tree
      const supervisorTree = getSupervisorTree();
      supervisorTree.unregisterInstance(instanceId);

      // Unregister from orchestration
      this.deps.unregisterOrchestration(instanceId);
      this.deps.clearFirstMessageTracking(instanceId);

      // End RLM session
      this.deps.endRlmSession(instanceId);

      // Clean up disk storage
      this.outputStorage.deleteInstance(instanceId).catch((err) => {
        logger.error('Failed to clean up storage', err instanceof Error ? err : undefined, { instanceId });
      });

      this.emit('removed', instanceId);
      this.deps.deleteInstance(instanceId);
    }
  }

  /**
   * Terminate all instances
   */
  async terminateAll(): Promise<void> {
    const instanceIds: string[] = [];
    this.deps.forEachInstance((_, id) => instanceIds.push(id));

    const promises = instanceIds.map((id) =>
      this.terminateInstance(id, false)
    );
    await Promise.all(promises);
  }

  // ============================================
  // Hibernation
  // ============================================

  /**
   * Hibernate an instance: save state, kill the adapter process, and mark the
   * instance as hibernated. The instance stays in the store so the UI can show
   * it. Call wakeInstance() to bring it back.
   */
  async hibernateInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (instance.status !== 'idle') {
      throw new Error(
        `Cannot hibernate instance ${instanceId}: status is '${instance.status}', expected 'idle'`
      );
    }

    this.transitionState(instance, 'hibernating');
    this.deps.queueUpdate(instanceId, 'hibernating', instance.contextUsage);

    try {
      // Persist session state to disk (archive=true keeps the file for wake).
      const continuity = getSessionContinuityManager();
      await continuity.startTracking(instance);
      await continuity.stopTracking(instanceId, true);

      // Mine transcript before hibernation (non-blocking)
      if (instance.outputBuffer.length >= 4) {
        try {
          const transcript = instance.outputBuffer
            .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
            .map((msg) => msg.type === 'user' ? `> ${msg.content}` : msg.content)
            .join('\n\n');

          if (transcript.length > 100) {
            const wing = instance.workingDirectory || 'default';
            const sourceFile = `session://${instanceId}/hibernate`;
            getConversationMiner().importFromString(transcript, {
              wing,
              sourceFile,
            });
            logger.info('Mined transcript before hibernation', { instanceId });
          }
        } catch (error) {
          logger.warn('Failed to mine transcript before hibernation', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Kill the adapter process without removing the instance from the store.
      const adapter = this.deps.getAdapter(instanceId);
      if (adapter) {
        await adapter.terminate(true);
        this.deps.deleteAdapter(instanceId);
      }
      this.deps.deleteDiffTracker?.(instanceId);

      instance.processId = null;

      // Record in HibernationManager.
      getHibernationManager().markHibernated(instanceId, {
        instanceId,
        displayName: instance.displayName,
        agentId: instance.agentId,
        sessionState: {},
        hibernatedAt: Date.now(),
        workingDirectory: instance.workingDirectory,
        contextUsage: {
          used: instance.contextUsage.used,
          total: instance.contextUsage.total,
        },
      });

      this.transitionState(instance, 'hibernated');
      this.deps.queueUpdate(instanceId, 'hibernated', instance.contextUsage);
      logger.info('Instance hibernated', { instanceId, displayName: instance.displayName });
    } catch (error) {
      this.transitionState(instance, 'failed');
      this.deps.queueUpdate(instanceId, 'failed', instance.contextUsage);
      logger.error('Failed to hibernate instance', error instanceof Error ? error : undefined, { instanceId });
      throw error;
    }
  }

  /**
   * Wake a hibernated instance: restore session state and spawn a new adapter.
   */
  async wakeInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (instance.status !== 'hibernated') {
      throw new Error(
        `Cannot wake instance ${instanceId}: status is '${instance.status}', expected 'hibernated'`
      );
    }

    this.transitionState(instance, 'waking');
    this.deps.queueUpdate(instanceId, 'waking', instance.contextUsage);

    const abortController = new AbortController();
    instance.abortController = abortController;

    const wakePromise = (async () => {
      const { signal } = abortController;
      try {
        if (signal.aborted) return;

        // Load saved session state from disk.
        const continuity = getSessionContinuityManager();
        const sessionState = await continuity.resumeSession(instanceId, {
          restoreMessages: true,
          restoreContext: true,
        });

        const savedThreadId =
          sessionState?.historyThreadId?.trim() || instance.historyThreadId;
        instance.historyThreadId = savedThreadId;
        if (sessionState?.displayName) {
          instance.displayName = sessionState.displayName;
        }
        if (sessionState?.isRenamed) {
          instance.isRenamed = sessionState.isRenamed;
        }
        if (sessionState?.provider) {
          instance.provider = sessionState.provider;
        }
        if (sessionState?.modelId) {
          instance.currentModel = sessionState.modelId;
        }
        if (sessionState?.contextUsage) {
          instance.contextUsage = {
            used: sessionState.contextUsage.used,
            total: sessionState.contextUsage.total,
            percentage: sessionState.contextUsage.total > 0
              ? Math.min(
                  (sessionState.contextUsage.used / sessionState.contextUsage.total) * 100,
                  100
                )
              : 0,
            costEstimate: sessionState.contextUsage.costEstimate,
          };
        }

        if (sessionState && sessionState.conversationHistory.length > 0) {
          // Restore recent messages into the output buffer so the UI can show them.
          const restored = sessionState.conversationHistory.slice(-50).map((entry, idx) => ({
            id: `restored-${idx}-${Date.now()}`,
            timestamp: entry.timestamp,
            type: (entry.role === 'user' ? 'user'
              : entry.role === 'assistant' ? 'assistant'
              : 'system') as OutputMessage['type'],
            content: entry.content,
          }));
          instance.outputBuffer = restored;
        }

        if (signal.aborted) return;

        const nativeSessionId = sessionState?.sessionId?.trim();
        const canAttemptNativeResume =
          Boolean(nativeSessionId)
          && !sessionState?.nativeResumeFailedAt;
        const fallbackReason = canAttemptNativeResume
          ? 'hibernate-wake-fallback'
          : sessionState?.nativeResumeFailedAt
            ? 'hibernate-wake-skip-failed-resume'
            : 'hibernate-wake-replay';
        const hasConversation = instance.outputBuffer.some(
          (message) => message.type === 'user' || message.type === 'assistant'
        );

        // Determine CLI type and build spawn options (same pattern as createInstance Phase 2).
        const cliType = await this.resolveCliTypeForInstance(instance);
        instance.sessionId = canAttemptNativeResume
          ? nativeSessionId!
          : generateId();
        const spawnOptions: UnifiedSpawnOptions = {
          sessionId: instance.sessionId,
          workingDirectory: instance.workingDirectory,
          yoloMode: instance.yoloMode,
          model: instance.currentModel,
          resume: canAttemptNativeResume,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        };

        let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);
        this.deps.setupAdapterEvents(instanceId, adapter);
        this.deps.setAdapter(instanceId, adapter);
        if (this.deps.setDiffTracker) {
          this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
        }

        if (signal.aborted) {
          await adapter.terminate(false).catch(() => { /* ignore */ });
          this.deps.deleteAdapter(instanceId);
          this.deps.deleteDiffTracker?.(instanceId);
          return;
        }

        let pid = await adapter.spawn();
        instance.processId = pid;

        // Create activity detector for woken instance
        const wakeDetector = new ActivityStateDetector(
          instanceId,
          instance.workingDirectory || process.cwd(),
          instance.provider ?? 'claude-cli',
        );
        if (pid) wakeDetector.setPid(pid);
        this.activityDetectors.set(instanceId, wakeDetector);
        // Inject detector into adapter if it supports activity recording
        const wakeAdapter = this.deps.getAdapter(instanceId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- setActivityDetector is not in CliAdapter interface; runtime check guards the call
        const wakeAdapterWithDetector = wakeAdapter as any;
        if (wakeAdapter && typeof wakeAdapterWithDetector.setActivityDetector === 'function') {
          wakeAdapterWithDetector.setActivityDetector(wakeDetector);
        }

        if (canAttemptNativeResume) {
          const resumeHealthy = await this.waitForResumeHealth(instanceId);
          if (!resumeHealthy) {
            logger.warn('Wake resume failed, falling back to replay continuity', {
              instanceId,
              nativeSessionId,
            });
            await continuity.markNativeResumeFailed(instanceId);
            // Remove event listeners BEFORE terminating so the exit handler
            // doesn't treat the resume adapter's exit as a real instance exit.
            adapter.removeAllListeners();
            await adapter.terminate(true).catch(() => { /* ignore */ });
            this.deps.deleteAdapter(instanceId);
            this.deps.deleteDiffTracker?.(instanceId);

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            await continuity.updateState(instanceId, {
              sessionId: fallbackSessionId,
              historyThreadId: instance.historyThreadId,
            });

            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              sessionId: fallbackSessionId,
              resume: false,
              forkSession: false,
            };
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);
            if (this.deps.setDiffTracker) {
              this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
            }
            pid = await adapter.spawn();
            instance.processId = pid;

            if (hasConversation) {
              await adapter.sendInput(
                this.buildReplayContinuityMessage(instance, fallbackReason)
              );
            }

            const fallbackNotice: OutputMessage = {
              id: generateId(),
              timestamp: Date.now(),
              type: 'system',
              content: 'Wake resume failed. Session restarted from the saved transcript.',
              metadata: {
                continuityReplay: true,
                reason: fallbackReason,
              },
            };
            this.deps.addToOutputBuffer(instance, fallbackNotice);
            this.emit('output', { instanceId, message: fallbackNotice });
          }
        } else if (hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, fallbackReason));
        }

        // Remove from HibernationManager tracking.
        getHibernationManager().markAwoken(instanceId);

        this.transitionState(instance, 'ready');
        // Include displayName so the renderer picks up any name restored from session state
        this.deps.queueUpdate(instanceId, 'ready', instance.contextUsage, undefined, instance.displayName);
        logger.info('Instance woken successfully', { instanceId, pid });
      } catch (error) {
        this.transitionState(instance, 'failed');
        this.deps.queueUpdate(instanceId, 'failed', instance.contextUsage);
        logger.error('Failed to wake instance', error instanceof Error ? error : undefined, { instanceId });
        throw error;
      } finally {
        instance.readyPromise = undefined;
        instance.abortController = undefined;
      }
    })();

    instance.readyPromise = wakePromise;
    wakePromise.catch(() => { /* rejection surfaced via readyPromise */ });

    await wakePromise;
  }

  private createSessionBoundaryMessage(): OutputMessage {
    return this.restartHelpers.createSessionBoundaryMessage();
  }

  private resetBackendSessionState(
    instance: Instance,
    cliType: CliType,
    options?: { resetTotalTokensUsed?: boolean; resetFirstMessageTracking?: boolean },
  ): void {
    this.restartHelpers.resetBackendSessionState(instance, cliType, options);
  }

  private async archiveRestartSnapshot(instance: Instance, messages: OutputMessage[]): Promise<void> {
    return this.restartHelpers.archiveRestartSnapshot(instance, messages);
  }

  private async nativeResumeAfterRestart(
    instanceId: string,
    providerSessionId: string
  ): Promise<RecoveryResult> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      return { success: false, error: `Instance ${instanceId} not found` };
    }

    const previousAdapter = this.deps.getAdapter(instanceId);
    const capabilities = this.getAdapterRuntimeCapabilities(previousAdapter);
    if (!capabilities.supportsResume || !providerSessionId || instance.sessionResumeBlacklisted) {
      return { success: false, error: 'Native resume unavailable for this session' };
    }

    const cliType = await this.resolveCliTypeForInstance(instance);
    const adapter = createCliAdapter(
      cliType,
      {
        sessionId: providerSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: true,
        forkSession: false,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
      },
      instance.executionLocation
    );

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      if (!(await this.waitForResumeHealth(instanceId, 15_000))) {
        throw new Error('Native resume did not stabilize');
      }
      await this.waitForAdapterWritable(instanceId, 3_000);
      instance.providerSessionId = providerSessionId;
      instance.sessionId = providerSessionId;
      instance.sessionResumeBlacklisted = false;
      instance.recoveryMethod = 'native';
      return { success: true, method: 'native-resume' };
    } catch (error) {
      instance.processId = null;
      if (this.deps.getAdapter(instanceId) === adapter) {
        this.deps.deleteAdapter(instanceId);
      }
      await adapter.terminate(true).catch(() => { /* ignore cleanup failure */ });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async replayFallbackAfterRestart(
    instanceId: string,
    _providerSessionId: string
  ): Promise<RecoveryResult> {
    void _providerSessionId;
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      return { success: false, error: `Instance ${instanceId} not found` };
    }

    const cliType = await this.resolveCliTypeForInstance(instance);
    const hasConversation = this.hasActiveConversation(instance);
    const fallbackHistory = hasConversation
      ? await this.buildFallbackHistory(instance, 'resume-failed-fallback')
      : undefined;
    const newProviderSessionId = generateId();

    this.resetBackendSessionState(instance, cliType);
    instance.providerSessionId = newProviderSessionId;
    instance.sessionId = newProviderSessionId;
    instance.sessionResumeBlacklisted = false;

    const adapter = createCliAdapter(
      cliType,
      {
        sessionId: newProviderSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: false,
        forkSession: false,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
      },
      instance.executionLocation
    );

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      await this.waitForAdapterWritable(instanceId, 3_000);
      if (fallbackHistory) {
        await adapter.sendInput(fallbackHistory);
      }
      instance.recoveryMethod = 'replay';
      return { success: true, method: 'replay-fallback' };
    } catch (error) {
      instance.processId = null;
      if (this.deps.getAdapter(instanceId) === adapter) {
        this.deps.deleteAdapter(instanceId);
      }
      await adapter.terminate(true).catch(() => { /* ignore cleanup failure */ });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // ============================================
  // Instance Restart
  // ============================================

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<void> {
    const release = await getSessionMutex().acquire(instanceId, 'restart');
    try {
      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      logger.info('[RESTART] begin', {
        instanceId,
        preUsed: instance.contextUsage?.used,
        preTotal: instance.contextUsage?.total,
        prePercentage: instance.contextUsage?.percentage,
        providerSessionId: instance.providerSessionId,
        restartCount: instance.restartCount,
        historyThreadId: instance.historyThreadId,
      });

      instance.restartEpoch += 1;
      instance.recoveryMethod = undefined;
      instance.processId = null;
      this.deps.clearPendingState?.(instanceId);
      this.deps.stopStuckTracking?.(instanceId);

      const oldAdapter = this.deps.getAdapter(instanceId);
      if (oldAdapter) {
        try {
          await oldAdapter.terminate(true);
        } catch (error) {
          logger.warn('Adapter terminate failed during restart, proceeding', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      instance.restartCount += 1;
      this.transitionState(instance, 'initializing');
      this.deps.queueUpdate(
        instanceId,
        'initializing',
        instance.contextUsage,
        instance.diffStats,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );

      const recovery = new SessionRecoveryHandler({
        nativeResume: (id, sessionId) => this.nativeResumeAfterRestart(id, sessionId),
        replayFallback: (id, sessionId) => this.replayFallbackAfterRestart(id, sessionId),
      });
      const providerSessionId = instance.providerSessionId || instance.sessionId;
      const result = await recovery.recover(instanceId, providerSessionId);

      if (!result.success) {
        instance.recoveryMethod = 'failed';
        this.transitionState(instance, 'error');
        logger.warn('Restart (resume context) failed; leaving instance in error state', {
          instanceId,
          providerSessionId,
          error: result.error,
        });
        this.deps.queueUpdate(
          instanceId,
          'error',
          instance.contextUsage,
          instance.diffStats,
          undefined,
          undefined,
          undefined,
          {
            providerSessionId: instance.providerSessionId,
            restartEpoch: instance.restartEpoch,
            recoveryMethod: instance.recoveryMethod,
            archivedUpToMessageId: instance.archivedUpToMessageId,
            historyThreadId: instance.historyThreadId,
          }
        );
        return;
      }

      if (instance.status === 'initializing') {
        this.transitionState(
          instance,
          result.method === 'replay-fallback' ? 'busy' : 'idle'
        );
      }
      this.deps.startStuckTracking?.(instanceId);
      this.deps.queueUpdate(
        instanceId,
        instance.status,
        instance.contextUsage,
        result.method === 'replay-fallback' ? null : instance.diffStats,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          recoveryMethod: instance.recoveryMethod,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );
    } finally {
      release();
    }
  }

  async restartFreshInstance(instanceId: string): Promise<void> {
    const release = await getSessionMutex().acquire(instanceId, 'restart-fresh');
    try {
      const instance = this.deps.getInstance(instanceId);
      if (!instance) {
        throw new Error(`Instance ${instanceId} not found`);
      }

      const cliType = await this.resolveCliTypeForInstance(instance);
      const previousMessages = [...instance.outputBuffer];
      const lastPreFreshMessageId = previousMessages.at(-1)?.id;

      instance.restartEpoch += 1;
      instance.recoveryMethod = undefined;
      instance.processId = null;
      this.deps.clearPendingState?.(instanceId);
      this.deps.stopStuckTracking?.(instanceId);

      const oldAdapter = this.deps.getAdapter(instanceId);
      if (oldAdapter) {
        try {
          await oldAdapter.terminate(true);
        } catch (error) {
          logger.warn('Adapter terminate failed during fresh restart, proceeding', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await this.archiveRestartSnapshot(instance, previousMessages);

      if (lastPreFreshMessageId) {
        instance.archivedUpToMessageId = lastPreFreshMessageId;
        this.deps.addToOutputBuffer(instance, this.createSessionBoundaryMessage());
      } else {
        instance.archivedUpToMessageId = undefined;
      }

      instance.historyThreadId = generateId();
      const newProviderSessionId = generateId();
      instance.providerSessionId = newProviderSessionId;
      instance.sessionId = newProviderSessionId;
      instance.sessionResumeBlacklisted = false;
      this.resetBackendSessionState(instance, cliType, {
        resetTotalTokensUsed: true,
        resetFirstMessageTracking: true,
      });

      const adapter = createCliAdapter(
        cliType,
        {
          sessionId: newProviderSessionId,
          workingDirectory: instance.workingDirectory,
          yoloMode: instance.yoloMode,
          model: instance.currentModel,
          resume: false,
          forkSession: false,
          mcpConfig: this.getMcpConfig(instance.executionLocation),
          permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
        },
        instance.executionLocation
      );

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      instance.restartCount += 1;
      this.transitionState(instance, 'initializing');
      this.deps.queueUpdate(
        instanceId,
        'initializing',
        instance.contextUsage,
        null,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );

      try {
        const pid = await adapter.spawn();
        instance.processId = pid;
        instance.recoveryMethod = 'fresh';
        this.transitionState(instance, 'idle');
        this.deps.startStuckTracking?.(instanceId);
      } catch (error) {
        instance.recoveryMethod = 'failed';
        this.transitionState(instance, 'error');
        logger.error('Failed to restart CLI with fresh context', error instanceof Error ? error : undefined, {
          instanceId,
        });
      }

      this.deps.queueUpdate(
        instanceId,
        instance.status,
        instance.contextUsage,
        null,
        undefined,
        undefined,
        undefined,
        {
          providerSessionId: instance.providerSessionId,
          restartEpoch: instance.restartEpoch,
          recoveryMethod: instance.recoveryMethod,
          archivedUpToMessageId: instance.archivedUpToMessageId,
          historyThreadId: instance.historyThreadId,
        }
      );
    } finally {
      release();
    }
  }

  // ============================================
  // Agent Mode Change
  // ============================================

  /**
   * Change the agent mode for an instance while preserving conversation context
   */
  async changeAgentMode(instanceId: string, newAgentId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'agent-mode-change');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change agent mode while instance is busy. Please wait for the current operation to complete.');
      }

      if (instance.agentId === newAgentId) {
        return instance;
      }

      // Resolve from registry first (allows markdown-defined agents). Fall back to built-ins for safety.
      const newAgent = await getAgentRegistry().resolveAgent(instance.workingDirectory, newAgentId);
      if (!newAgent) {
        const builtin = getAgentById(newAgentId);
        if (!builtin) throw new Error(`Agent ${newAgentId} not found`);
      }

      const oldAgentId = instance.agentId;
      logger.info('Changing agent mode', { instanceId, oldAgentId, newAgentId });

      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        await oldAdapter.terminate(true);
        this.deps.deleteAdapter(instanceId);
      }

      // Update instance with new agent
      instance.agentId = newAgentId;
      instance.agentMode = newAgent.mode;
      this.transitionState(instance, 'initializing');

      // If leaving plan mode, reset plan mode state
      if (instance.planMode.enabled && newAgent.mode !== 'plan') {
        instance.planMode = {
          enabled: false,
          state: 'off',
          planContent: undefined,
          approvedAt: undefined
        };
        logger.info('Auto-exited plan mode due to agent mode change', { instanceId, newAgentId });
      }

      const disallowedTools = [...getDisallowedTools(newAgent.permissions), ...PRINT_MODE_INCOMPATIBLE_TOOLS];

      // Build proactive tool filter for pre-filtering tool definitions (defense-in-depth)
      const denyRules: DenyRule[] = disallowedTools.map(tool => ({
        pattern: tool,
        type: 'blanket' as const,
      }));
      const toolFilter = new ToolListFilter(denyRules);

      // Store filter on instance for downstream consumers
      if (!instance.metadata) instance.metadata = {};
      instance.metadata['toolFilter'] = toolFilter;

      const defaultAllowedTools = instance.yoloMode ? undefined : [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'Task', 'TaskOutput', 'TodoWrite', 'WebFetch', 'WebSearch',
        'NotebookEdit', 'Skill'
      ];

      const cliType = await this.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: newAgent.systemPrompt,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        allowedTools: defaultAllowedTools,
        disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
      };

      let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);

      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after agent mode change');
          }
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();

            if (hasConversation) {
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('Agent mode changed successfully', { instanceId, newAgentId, pid, resumed: shouldResume });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'agent-mode-change'));
        }

        // Build a mode transition message. When resuming, the system prompt can't be changed,
        // so we send an authoritative message that overrides the previous mode's instructions.
        let modeChangeMessage: string;
        if (oldAgentId === 'plan' && newAgentId !== 'plan') {
          // Explicitly revoke plan mode restrictions since the old system prompt persists in the session
          modeChangeMessage = `[SYSTEM MODE CHANGE - IMPORTANT]
Your mode has been changed from PLAN to ${newAgent.name.toUpperCase()}.
ALL previous PLAN MODE restrictions are now LIFTED. You are NO LONGER in plan mode.
You now have FULL access to: read files, write files, edit files, execute bash commands, and all other tools.
${newAgent.systemPrompt ? `New instructions: ${newAgent.systemPrompt}` : `You are in ${newAgent.name} mode: ${newAgent.description || 'Full access mode.'}`}
Proceed with implementation. Do NOT request to switch modes - you are already in ${newAgent.name} mode.`;
        } else {
          modeChangeMessage = `[System: Agent mode changed to ${newAgent.name}. ${newAgent.description || ''}${newAgent.systemPrompt ? `\n\nNew instructions:\n${newAgent.systemPrompt}` : ''}]`;
        }
        await adapter.sendInput(modeChangeMessage);
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to change agent mode', error instanceof Error ? error : undefined, { instanceId, newAgentId });
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('agent-changed', {
        instanceId,
        oldAgentId,
        newAgentId,
        agentName: newAgent.name
      });

      return instance;
    } finally {
      release();
    }
  }

  // ============================================
  // YOLO Mode Toggle
  // ============================================

  /**
   * Toggle YOLO mode for an instance while preserving conversation context
   */
  async toggleYoloMode(instanceId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'yolo-toggle');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot toggle YOLO mode while instance is busy. Please wait for the current operation to complete.');
      }

      const newYoloMode = !instance.yoloMode;
      logger.info('Toggling YOLO mode', {
        instanceId,
        currentYoloMode: instance.yoloMode,
        newYoloMode,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      // Check if there's actually a conversation to resume
      // If outputBuffer is empty (or only contains system messages), start fresh instead of resuming
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );
      logger.debug('Checking conversation resume status', {
        instanceId,
        hasConversation,
        outputBufferLength: instance.outputBuffer.length
      });

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        logger.debug('Terminating old adapter', { instanceId });
        // Delete from map FIRST to prevent race condition with exit handler
        this.deps.deleteAdapter(instanceId);
        logger.debug('Old adapter deleted from map, now terminating', { instanceId });
        await oldAdapter.terminate(true);
        logger.debug('Old adapter terminated', { instanceId });
      }

      instance.yoloMode = newYoloMode;
      this.transitionState(instance, 'initializing');

      if (newYoloMode) {
        logger.warn('YOLO mode enabled for instance', {
          instanceId: instance.id,
          parentId: instance.parentId,
          provider: instance.provider
        });
      }

      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const disallowedTools = [...getDisallowedTools(agent.permissions), ...PRINT_MODE_INCOMPATIBLE_TOOLS];

      // Build proactive tool filter for pre-filtering tool definitions (defense-in-depth)
      const denyRules: DenyRule[] = disallowedTools.map(tool => ({
        pattern: tool,
        type: 'blanket' as const,
      }));
      const toolFilter = new ToolListFilter(denyRules);

      // Store filter on instance for downstream consumers
      if (!instance.metadata) instance.metadata = {};
      instance.metadata['toolFilter'] = toolFilter;

      const allowedTools = newYoloMode ? undefined : [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'Task', 'TaskOutput', 'TodoWrite', 'WebFetch', 'WebSearch',
        'NotebookEdit', 'Skill'
      ];

      const cliType = await this.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: agent.systemPrompt,
        yoloMode: newYoloMode,
        allowedTools,
        disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(newYoloMode),
      };
      logger.debug('Spawn options configured', {
        instanceId,
        resume: spawnOptions.resume,
        forkSession: spawnOptions.forkSession,
        sessionId: spawnOptions.sessionId
      });

      let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);

      logger.debug('Setting up adapter events', { instanceId });
      this.deps.setupAdapterEvents(instanceId, adapter);
      logger.debug('Storing new adapter', { instanceId });
      this.deps.setAdapter(instanceId, adapter);
      logger.debug('New adapter stored', {
        instanceId,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      try {
        logger.debug('Spawning new adapter', { instanceId });
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after YOLO toggle');
          }
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            // Retry without resume
            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();

            if (hasConversation) {
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('YOLO mode toggled successfully', { instanceId, pid, newYoloMode, resumed: shouldResume });
        logger.debug('Adapter exists after spawn', { instanceId, adapterExists: !!this.deps.getAdapter(instanceId) });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'yolo-toggle'));
        }

        const modeMessage = newYoloMode
          ? '[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]'
          : '[System: YOLO mode disabled - tool permissions will now require approval.]';
        logger.debug('Sending mode message to adapter', { instanceId, newYoloMode });
        await adapter.sendInput(modeMessage);
        logger.debug('Mode message sent', { instanceId, adapterExists: !!this.deps.getAdapter(instanceId) });
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to toggle YOLO mode', error instanceof Error ? error : undefined, { instanceId, newYoloMode });
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('yolo-toggled', {
        instanceId,
        yoloMode: newYoloMode
      });

      logger.debug('toggleYoloMode complete', {
        instanceId,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });
      return instance;
    } finally {
      release();
    }
  }

  // ============================================
  // Deferred Permission Resume (delegated to DeferredPermissionHandler)
  // ============================================

  async resumeAfterDeferredPermission(
    instanceId: string,
    approved: boolean,
  ): Promise<void> {
    return this.deferredPermission.resumeAfterDeferredPermission(instanceId, approved);
  }

  // ============================================
  // Model Switching
  // ============================================

  /**
   * Change the model for an instance while preserving conversation context.
   * Follows the same pattern as toggleYoloMode: terminate adapter, update state, respawn with resume.
   */
  async changeModel(instanceId: string, newModel: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'model-change');
    try {
      if (instance.status === 'busy') {
        throw new Error('Cannot change model while instance is busy. Please wait for the current operation to complete.');
      }

      const oldModel = instance.currentModel || 'default';
      logger.info('Changing model', {
        instanceId,
        oldModel,
        newModel,
        adapterExists: !!this.deps.getAdapter(instanceId)
      });

      // Check if there's a conversation to resume
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );

      // Terminate existing adapter
      const oldAdapter = this.deps.getAdapter(instanceId);
      const oldAdapterCapabilities = this.getAdapterRuntimeCapabilities(oldAdapter);
      if (oldAdapter) {
        this.deps.deleteAdapter(instanceId);
        await oldAdapter.terminate(true);
      }

      // Update instance state
      this.transitionState(instance, 'initializing');

      // Resolve agent and permissions (same as toggleYoloMode)
      const agent = getAgentById(instance.agentId) || getDefaultAgent();
      const disallowedTools = [...getDisallowedTools(agent.permissions), ...PRINT_MODE_INCOMPATIBLE_TOOLS];

      // Build proactive tool filter for pre-filtering tool definitions (defense-in-depth)
      const denyRules: DenyRule[] = disallowedTools.map(tool => ({
        pattern: tool,
        type: 'blanket' as const,
      }));
      const toolFilter = new ToolListFilter(denyRules);

      // Store filter on instance for downstream consumers
      if (!instance.metadata) instance.metadata = {};
      instance.metadata['toolFilter'] = toolFilter;

      const allowedTools = instance.yoloMode ? undefined : [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'Task', 'TaskOutput', 'TodoWrite', 'WebFetch', 'WebSearch',
        'NotebookEdit', 'Skill'
      ];

      const cliType = await this.resolveCliTypeForInstance(instance);
      const shouldResume = hasConversation && oldAdapterCapabilities.supportsResume;
      const shouldForkSession = shouldResume && oldAdapterCapabilities.supportsForkSession;

      // Validate model against provider before passing it
      let validatedModel: string | undefined = newModel;
      if (cliType !== 'claude') {
        if (isModelTier(newModel)) {
          validatedModel = resolveModelForTier(newModel, cliType);
        }

        const providerModels = getModelsForProvider(cliType);
        const modelToValidate = validatedModel;
        const allowCodexDynamicModel =
          modelToValidate !== undefined &&
          cliType === 'codex' &&
          looksLikeCodexModelId(modelToValidate);
        if (
          modelToValidate !== undefined &&
          providerModels.length > 0 &&
          !providerModels.some(m => m.id === modelToValidate) &&
          !allowCodexDynamicModel
        ) {
          logger.warn('Model not valid for target provider during changeModel, using provider default', {
            model: modelToValidate,
            provider: cliType,
            fallbackModel: 'provider-default',
          });
          validatedModel = undefined;
        }
      }

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : (shouldResume ? instance.sessionId : generateId());
      instance.sessionId = newSessionId;

      instance.currentModel = validatedModel;
      const contextTotal = getProviderModelContextWindow(cliType, validatedModel);
      instance.contextUsage = {
        ...instance.contextUsage,
        total: contextTotal,
        percentage: contextTotal > 0
          ? Math.min((instance.contextUsage.used / contextTotal) * 100, 100)
          : 0
      };

      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        systemPrompt: agent.systemPrompt,
        model: validatedModel,
        yoloMode: instance.yoloMode,
        allowedTools,
        disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(instance.executionLocation),
        permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
      };

      let adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after model change');
          }
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Failed to spawn with resume, falling back to fresh session', { error: spawnError instanceof Error ? spawnError.message : String(spawnError), instanceId });
            await adapter.terminate(true);

            const fallbackOptions = { ...spawnOptions, resume: false, forkSession: false, sessionId: generateId() };
            instance.sessionId = fallbackOptions.sessionId;
            adapter = createCliAdapter(cliType, fallbackOptions, instance.executionLocation);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();

            if (hasConversation) {
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'resume-failed-fallback'));
            }
          } else {
            throw spawnError;
          }
        }

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        logger.info('Model changed successfully', {
          instanceId,
          pid,
          newModel: validatedModel || 'provider-default',
          resumed: shouldResume,
        });

        if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'model-change'));
        }

        // Notify the instance about the model change
        await adapter.sendInput(
          `[System: Model changed from ${oldModel} to ${validatedModel || newModel}. Conversation context has been preserved.]`
        );
      } catch (error) {
        this.transitionState(instance, 'error');
        logger.error('Failed to change model', error instanceof Error ? error : undefined, { instanceId, newModel });
        throw error;
      }

      this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
      this.emit('model-changed', {
        instanceId,
        model: newModel
      });

      return instance;
    } finally {
      release();
    }
  }

  // ============================================
  // Instance Interrupt
  // ============================================

  /**
   * Interrupt an instance (like Ctrl+C) — delegates to InterruptRespawnHandler.
   *
   * When the instance is 'busy', sends SIGINT and transitions to 'respawning'.
   * When the instance is 'respawning' (e.g., second Escape press while stuck),
   * force-terminates the adapter so the frontend can restart cleanly.
   */
  interruptInstance(instanceId: string): boolean {
    return this.interruptRespawn.interrupt(instanceId);
  }

  /**
   * Respawn an instance after interrupt to continue the session
   * (delegates to InterruptRespawnHandler).
   */
  async respawnAfterInterrupt(instanceId: string): Promise<void> {
    return this.interruptRespawn.respawnAfterInterrupt(instanceId);
  }

  /**
   * Respawn an instance after its CLI process exited unexpectedly
   * (delegates to InterruptRespawnHandler).
   *
   * Uses --resume to reconnect to the existing CLI session. Falls back to
   * a fresh session with replay continuity if resume fails.
   */
  async respawnAfterUnexpectedExit(instanceId: string): Promise<void> {
    return this.interruptRespawn.respawnAfterUnexpectedExit(instanceId);
  }

  // ============================================
  // Plan Mode Management (delegated to PlanModeManager)
  // ============================================

  enterPlanMode(instanceId: string): Instance {
    return this.planMode.enterPlanMode(instanceId);
  }

  exitPlanMode(instanceId: string, force = false): Instance {
    return this.planMode.exitPlanMode(instanceId, force);
  }

  approvePlan(instanceId: string, planContent?: string): Instance {
    return this.planMode.approvePlan(instanceId, planContent);
  }

  updatePlanContent(instanceId: string, planContent: string): Instance {
    return this.planMode.updatePlanContent(instanceId, planContent);
  }

  getPlanModeState(instanceId: string): {
    enabled: boolean;
    state: string;
    planContent?: string;
  } {
    return this.planMode.getPlanModeState(instanceId);
  }

  // ============================================
  // Instance Rename
  // ============================================

  /**
   * Rename an instance
   */
  renameInstance(instanceId: string, displayName: string): void {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.displayName = displayName;
    instance.isRenamed = true;
    this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage, undefined, displayName);
  }

  // ============================================
  // Idle Instance Management
  // ============================================
  //
  // The periodic check loop, zombie cleanup, and memory-pressure half-terminate
  // live in `./lifecycle/idle-monitor.ts` and are wired up in the constructor.
  // `dispatchRecoveryActions` stays here because it calls `restartInstance`,
  // which is deeply coupled to the lifecycle manager; IdleMonitor invokes it
  // via the `dispatchRecovery` callback.

  /**
   * Read recovery context flags set by recipes and dispatch the corresponding
   * side-effects (respawn, interrupt + prompt injection, etc.).
   */
  private async dispatchRecoveryActions(instanceId: string, failure: DetectedFailure): Promise<void> {
    const ctx = failure.context;

    // requestRespawn — restart the instance (optionally with resume cursor)
    if (ctx['requestRespawn']) {
      logger.info('Recovery action: respawning instance', { instanceId });
      await this.restartInstance(instanceId);
      return; // restart replaces the process — no further actions apply
    }

    // sendInterrupt + injectMessage — interrupt the stuck agent then inject a nudge
    if (ctx['sendInterrupt']) {
      const adapter = this.deps.getAdapter(instanceId);
      if (adapter) {
        adapter.interrupt();
        const message = ctx['injectMessage'] as string | undefined;
        if (message) {
          // Small delay to let the CLI process the interrupt before we send input
          await new Promise(resolve => setTimeout(resolve, 500));
          await adapter.sendInput(message);
          logger.info('Recovery action: interrupted and injected message', { instanceId, message });
        } else {
          logger.info('Recovery action: interrupted instance', { instanceId });
        }
      } else {
        logger.warn('Recovery action: cannot interrupt — no adapter', { instanceId });
      }
    }

    // pauseAgent — set instance status so the UI can indicate paused state
    if (ctx['pauseAgent']) {
      const instance = this.deps.getInstance(instanceId);
      if (instance) {
        instance.activityState = 'blocked';
        logger.info('Recovery action: paused agent (set blocked)', { instanceId });
      }
    }
  }

  // ============================================
  // Memory Monitoring
  // ============================================

  private setupMemoryMonitoring(): void {
    this.memoryMonitor.on('warning', (stats) => {
      logger.warn('Memory warning', stats as Record<string, unknown>);
      this.emit('memory:warning', stats);
    });

    this.memoryMonitor.on('critical', (stats) => {
      logger.error('Memory critical', undefined, stats as Record<string, unknown>);
      this.emit('memory:critical', stats);

      // Disable warm-start under critical memory pressure to free resources.
      if (this.deps.warmStartManager) {
        logger.info('Disabling warm-start due to critical memory pressure');
        this.deps.warmStartManager.setEnabled(false);
      }

      const settingsAll = this.settings.getAll();
      if (settingsAll.autoTerminateOnMemoryPressure) {
        this.idleMonitor.terminateIdleHalf();
      }
    });

    this.memoryMonitor.on('normal', () => {
      // Re-enable warm-start once pressure returns to normal.
      if (this.deps.warmStartManager) {
        logger.info('Re-enabling warm-start after memory pressure resolved');
        this.deps.warmStartManager.setEnabled(true);
      }
    });

    this.memoryMonitor.on('stats', (stats) => {
      this.emit('memory:stats', stats);
    });

    this.memoryMonitor.start();
  }

  /**
   * Get memory statistics
   */
  getMemoryStats() {
    return {
      process: this.memoryMonitor.getStats(),
      storage: this.outputStorage.getTotalStats(),
      pressureLevel: this.memoryMonitor.getPressureLevel()
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    this.idleMonitor.stop();
    this.memoryMonitor.stop();
  }
}
