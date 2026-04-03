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
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import {
  getModelsForProvider,
  getProviderModelContextWindow,
  isModelTier,
  looksLikeCodexModelId,
  resolveModelForTier
} from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHistoryManager } from '../history';
import { getMemoryMonitor, getOutputStorageManager } from '../memory';
import { getSupervisorTree } from '../process';
import { getDefaultAgent, getAgentById } from '../../shared/types/agent.types';
import { getAgentRegistry } from '../agents/agent-registry';
import { getPermissionManager } from '../security/permission-manager';
import { getDisallowedTools } from '../../shared/utils/permission-mapper';
import { generateId } from '../../shared/utils/id-generator';
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
import { buildReplayContinuityMessage as buildSharedReplayContinuityMessage } from '../session/replay-continuity';
import { buildFallbackHistoryMessage } from '../session/fallback-history';
import { WarmStartManager } from './warm-start-manager';
import { SessionDiffTracker } from './session-diff-tracker';
import { InstanceStateMachine } from './instance-state-machine';
import { getAutoTitleService } from './auto-title-service';

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
  queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage, diffStats?: SessionDiffStats, displayName?: string) => void;
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
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private deps: LifecycleDependencies;

  /** Returns MCP config paths to pass to spawned CLI instances. */
  private getMcpConfig(): string[] {
    try {
      if (existsSync(MCP_CONFIG_PATH)) {
        logger.info('MCP config found', { path: MCP_CONFIG_PATH });
        return [MCP_CONFIG_PATH];
      }
      logger.warn('MCP config not found — spawned instances will not have custom MCP servers', {
        expectedPath: MCP_CONFIG_PATH,
        isPackaged: app.isPackaged,
      });
    } catch (err) {
      logger.error('Failed to check MCP config', err instanceof Error ? err : new Error(String(err)), {
        path: MCP_CONFIG_PATH,
      });
    }
    return [];
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
        if (node?.status === 'connected') {
          return { type: 'remote', nodeId: config.forceNodeId };
        }
      } catch {
        // Remote node module not available — fall through to local
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
          return { type: 'remote', nodeId: node.id };
        }
      } catch {
        // Remote node module not available — fall through to local
      }
    }

    // 3. Default: local
    return { type: 'local' };
  }

  constructor(deps: LifecycleDependencies) {
    super();
    this.deps = deps;
    this.startIdleCheckTimer();
    this.setupMemoryMonitoring();
  }

  // ============================================
  // State Machine Integration
  // ============================================

  /**
   * Soft-validated state transition.
   *
   * Attempts to transition the instance's state machine to `newState`.
   * If the transition is invalid, logs a warning but still sets the status
   * so that existing behaviour is preserved (observability-only, no breakage).
   * If no state machine exists for the instance, falls back to direct assignment.
   */
  private transitionState(instance: Instance, newState: InstanceStatus): void {
    const sm = this.deps.getStateMachine?.(instance.id);
    if (!sm) {
      // Legacy/unknown instance — fall back to direct assignment.
      instance.status = newState;
      return;
    }

    if (sm.canTransition(newState)) {
      sm.transition(newState);
    } else {
      logger.warn('Invalid state transition detected', {
        instanceId: instance.id,
        from: sm.current,
        to: newState,
      });
    }
    instance.status = newState;
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
    };
  }

  private async resolveCliTypeForInstance(instance: Instance): Promise<CliType> {
    const settingsAll = this.settings.getAll();
    return resolveCliType(instance.provider, settingsAll.defaultCli);
  }

  private buildReplayContinuityMessage(instance: Instance, reason: string): string {
    return buildSharedReplayContinuityMessage(instance.outputBuffer, { reason })
      || [
        '[SYSTEM CONTINUITY NOTICE]',
        `Native resume is unavailable for this provider. Continuity mode is replay-based (${reason}).`,
        'Continue the previous task and ask for clarification only if essential context is missing.',
        '[END CONTINUITY NOTICE]',
      ].join('\n');
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

  /**
   * Build a rich fallback history message when --resume fails.
   * Merges live + historical messages, deduplicates, then creates a
   * token-budget-aware recovery message.
   */
  private async buildFallbackHistory(instance: Instance, reason: string): Promise<string> {
    const outputStorage = getOutputStorageManager();
    const historicalMessages = await outputStorage.loadMessages(instance.id);

    // Merge historical + live, dedup by message ID
    const merged = [...historicalMessages, ...instance.outputBuffer];
    const seenIds = new Set<string>();
    const deduped: OutputMessage[] = [];
    for (const m of merged) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
      deduped.push(m);
    }

    // Get context window for budget calculation
    const contextWindow = getProviderModelContextWindow(instance.provider, instance.currentModel);

    const fallback = buildFallbackHistoryMessage(deduped, reason, contextWindow);
    if (fallback) return fallback;

    // Final fallback: use old summary-based method
    return this.buildReplayContinuityMessage(instance, reason);
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

  private async waitForResumeHealth(
    instanceId: string,
    timeoutMs = 5000,
    pollIntervalMs = 200
  ): Promise<boolean> {
    const isHealthy = (): boolean => {
      const instance = this.deps.getInstance(instanceId);
      const adapter = this.deps.getAdapter(instanceId);
      if (!instance || !adapter) {
        return false;
      }

      return (
        instance.processId !== null
        && instance.status !== 'error'
        && instance.status !== 'failed'
        && instance.status !== 'terminated'
      );
    };

    if (!isHealthy()) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(isHealthy());
      }, timeoutMs);

      const poll = setInterval(() => {
        if (!isHealthy()) {
          cleanup();
          resolve(false);
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

    // Create instance object
    const instance: Instance = {
      id: generateId(),
      displayName: config.displayName || path.basename(resolvedWorkingDir) || `Instance ${Date.now()}`,
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
      sessionId,
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

        // Append tool permission clarification to prevent models from hallucinating
        // permission issues when commands fail for unrelated reasons (test failures, etc.)
        systemPrompt += '\n\n---\n\n' +
          '[Tool Permissions] All tool calls in this environment are auto-approved. ' +
          'You do NOT need user permission to run any tool, including Bash, Write, or Edit. ' +
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
                logger.warn('Model not valid for target provider, using provider default', {
                  model: resolvedModel,
                  provider: resolvedCliType,
                  validModels: providerModels.map(m => m.id),
                  fallbackModel: 'provider-default',
                });
                resolvedModel = undefined;
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
          mcpConfig: this.getMcpConfig(),
        };

        // Check for a pre-warmed adapter before spawning fresh.
        // NEVER use warm-start for resume operations — warm adapters have fresh sessions
        // with no conversation context. Resume requires --resume <sessionId> on a freshly
        // spawned CLI process.
        const warmAdapter = config.resume
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
              this.triggerAutoTitle(instance, initialUserMessage.content);
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
              this.deps.queueUpdate(instance.id, 'failed', instance.contextUsage);
              throw error;
            }
          }
        } else {
          const executionLocation = this.resolveExecutionLocation(config);
          instance.executionLocation = executionLocation;
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
            this.transitionState(instance, 'idle');
            this.deps.queueUpdate(instance.id, 'idle', instance.contextUsage);
            this.deps.startStuckTracking?.(instance.id);
            logger.info('CLI spawned successfully', { pid, instanceId: instance.id });

            // Send initial prompt if provided
            if (initialUserMessage) {
              if (!seededInitialUserMessage) {
                this.deps.addToOutputBuffer(instance, initialUserMessage);
                this.emit('output', { instanceId: instance.id, message: initialUserMessage });
              }
              await adapter.sendInput(initialUserMessage.content, config.attachments);
              this.triggerAutoTitle(instance, initialUserMessage.content);
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

    if (adapter) {
      await adapter.terminate(graceful);
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
          mcpConfig: this.getMcpConfig(),
        };

        let adapter = createCliAdapter(cliType, spawnOptions);
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

        if (canAttemptNativeResume) {
          const resumeHealthy = await this.waitForResumeHealth(instanceId);
          if (!resumeHealthy) {
            logger.warn('Wake resume failed, falling back to replay continuity', {
              instanceId,
              nativeSessionId,
            });
            await continuity.markNativeResumeFailed(instanceId);
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
            adapter = createCliAdapter(cliType, fallbackOptions);
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

  // ============================================
  // Instance Restart
  // ============================================

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const cliType = await this.resolveCliTypeForInstance(instance);

    // Stop stuck tracking before terminating existing adapter
    this.deps.stopStuckTracking?.(instanceId);

    // Terminate existing adapter
    const oldAdapter = this.deps.getAdapter(instanceId);
    if (oldAdapter) {
      await oldAdapter.terminate(true);
    }

    // Generate new session ID
    const newSessionId = generateId();
    instance.sessionId = newSessionId;
    instance.outputBuffer = [];
    instance.contextUsage = {
      used: 0,
      total: getProviderModelContextWindow(cliType, instance.currentModel),
      percentage: 0
    };
    instance.diffStats = undefined;
    instance.totalTokensUsed = 0;

    // Reset first message tracking
    this.deps.clearFirstMessageTracking(instanceId);

    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: newSessionId,
      workingDirectory: instance.workingDirectory,
      yoloMode: instance.yoloMode,
      model: instance.currentModel,
      mcpConfig: this.getMcpConfig(),
    };

    const adapter = createCliAdapter(cliType, spawnOptions);

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);
    this.deps.deleteDiffTracker?.(instanceId);
    if (this.deps.setDiffTracker) {
      this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
    }

    // Spawn new process
    this.transitionState(instance, 'initializing');
    instance.restartCount++;

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      this.transitionState(instance, 'idle');
      this.deps.startStuckTracking?.(instanceId);
    } catch (error) {
      this.transitionState(instance, 'error');
      logger.error('Failed to restart CLI', error instanceof Error ? error : undefined, { instanceId });
    }

    this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
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
        mcpConfig: this.getMcpConfig(),
      };

      let adapter = createCliAdapter(cliType, spawnOptions);

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
            adapter = createCliAdapter(cliType, fallbackOptions);
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
        mcpConfig: this.getMcpConfig(),
      };
      logger.debug('Spawn options configured', {
        instanceId,
        resume: spawnOptions.resume,
        forkSession: spawnOptions.forkSession,
        sessionId: spawnOptions.sessionId
      });

      let adapter = createCliAdapter(cliType, spawnOptions);

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
            adapter = createCliAdapter(cliType, fallbackOptions);
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
          ? '[System: YOLO mode enabled - all tool permissions are now auto-approved.]'
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
        mcpConfig: this.getMcpConfig(),
      };

      let adapter = createCliAdapter(cliType, spawnOptions);
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
            adapter = createCliAdapter(cliType, fallbackOptions);
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
   * Interrupt an instance (like Ctrl+C)
   */
  interruptInstance(instanceId: string): boolean {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    if (!adapter || !instance) {
      logger.warn('Cannot interrupt instance: not found', { instanceId });
      return false;
    }

    // Only allow interrupt when busy - block during respawning, initializing, etc.
    if (instance.status !== 'busy') {
      logger.warn('Cannot interrupt instance: not busy', { instanceId, status: instance.status });
      return false;
    }

    this.deps.markInterrupted(instanceId);

    const success = adapter.interrupt();
    if (success) {
      // Use 'respawning' status to prevent further interrupts during recovery
      this.transitionState(instance, 'respawning');
      instance.lastActivity = Date.now();
      this.deps.queueUpdate(instanceId, 'respawning', instance.contextUsage);
    } else {
      this.deps.clearInterrupted(instanceId);
    }

    return success;
  }

  /**
   * Respawn an instance after interrupt to continue the session
   */
  async respawnAfterInterrupt(instanceId: string): Promise<void> {
    logger.info('Starting respawn after interrupt', { instanceId });

    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'respawn-interrupt');
    try {
      const previousAdapter = this.deps.getAdapter(instanceId);
      const capabilities = this.getAdapterRuntimeCapabilities(previousAdapter);
      const sessionId = instance.sessionId;
      logger.debug('Respawning with session ID', { instanceId, sessionId });
      if (!sessionId && capabilities.supportsResume) {
        throw new Error(`Instance ${instanceId} has no session ID to resume`);
      }
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );
      const shouldResume = capabilities.supportsResume && Boolean(sessionId);
      const shouldForkSession = shouldResume && capabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.resolveCliTypeForInstance(instance);

      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(),
      };
      const adapter = createCliAdapter(cliType, spawnOptions);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        logger.debug('Spawning new process after interrupt', { instanceId });
        let pid: number;
        let actuallyResumed = shouldResume;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after interrupt');
          }
        } catch (spawnError) {
          // Resume failed (e.g., corrupted session with empty messages).
          // Fall back to a fresh session with replay continuity message.
          if (shouldResume) {
            logger.warn('Resume failed after interrupt, falling back to fresh session', {
              instanceId,
              error: spawnError instanceof Error ? spawnError.message : String(spawnError),
            });
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            await adapter.terminate(true).catch(() => {});

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            const fallbackAdapter = createCliAdapter(cliType, fallbackOptions);
            this.deps.setupAdapterEvents(instanceId, fallbackAdapter);
            this.deps.setAdapter(instanceId, fallbackAdapter);

            pid = await fallbackAdapter.spawn();
            actuallyResumed = false;

            if (hasConversation) {
              await fallbackAdapter.sendInput(
                await this.buildFallbackHistory(instance, 'resume-failed-fallback')
              );
            }
          } else {
            throw spawnError;
          }
        }
        logger.info('Process respawned successfully', { instanceId, pid, resumed: actuallyResumed });

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        instance.lastActivity = Date.now();

        if (!actuallyResumed && shouldResume) {
          // Already sent continuity message in fallback path above
        } else if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'interrupt-respawn'));
        }

        const message = {
          id: generateId(),
          type: 'system' as const,
          content: actuallyResumed ? 'Interrupted — waiting for input' : 'Interrupted — session restarted (resume failed)',
          timestamp: Date.now()
        };
        this.deps.addToOutputBuffer(instance, message);
        this.emit('output', { instanceId, message });

        this.deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
        logger.info('Respawn after interrupt complete', { instanceId });
      } catch (error) {
        logger.error('Failed to spawn after interrupt', error instanceof Error ? error : undefined, { instanceId });
        this.transitionState(instance, 'error');
        instance.processId = null;
        this.deps.queueUpdate(instanceId, 'error');
        throw error;
      }
    } finally {
      release();
    }
  }

  /**
   * Respawn an instance after its CLI process exited unexpectedly.
   * Uses --resume to reconnect to the existing CLI session.
   * Falls back to a fresh session with replay continuity if resume fails.
   */
  async respawnAfterUnexpectedExit(instanceId: string): Promise<void> {
    logger.info('Auto-respawning after unexpected exit', { instanceId });

    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const release = await getSessionMutex().acquire(instanceId, 'respawn-unexpected');
    try {
      const previousAdapter = this.deps.getAdapter(instanceId);
      const capabilities = this.getAdapterRuntimeCapabilities(previousAdapter);
      const sessionId = instance.sessionId;
      const hasConversation = instance.outputBuffer.some(
        (msg) => msg.type === 'user' || msg.type === 'assistant'
      );
      const shouldResume = capabilities.supportsResume && Boolean(sessionId);
      const shouldForkSession = shouldResume && capabilities.supportsForkSession;

      const newSessionId = shouldResume && shouldForkSession
        ? generateId()
        : shouldResume
          ? sessionId
          : generateId();
      instance.sessionId = newSessionId;

      const cliType = await this.resolveCliTypeForInstance(instance);

      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: shouldResume ? sessionId : newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode,
        model: instance.currentModel,
        resume: shouldResume,
        forkSession: shouldForkSession,
        mcpConfig: this.getMcpConfig(),
      };
      let adapter = createCliAdapter(cliType, spawnOptions);
      this.deps.setupAdapterEvents(instanceId, adapter);
      this.deps.setAdapter(instanceId, adapter);

      try {
        let pid: number;
        let actuallyResumed = shouldResume;
        try {
          pid = await adapter.spawn();
          instance.processId = pid;
          if (shouldResume && !(await this.waitForResumeHealth(instanceId))) {
            throw new Error('Native resume did not stabilize after unexpected exit');
          }
        } catch (spawnError) {
          if (shouldResume) {
            logger.warn('Resume failed during auto-respawn, falling back to fresh session', {
              instanceId,
              error: spawnError instanceof Error ? spawnError.message : String(spawnError),
            });
            await adapter.terminate(true).catch(() => { /* ignore */ });

            const fallbackSessionId = generateId();
            instance.sessionId = fallbackSessionId;
            const fallbackOptions: UnifiedSpawnOptions = {
              ...spawnOptions,
              resume: false,
              forkSession: false,
              sessionId: fallbackSessionId,
            };
            adapter = createCliAdapter(cliType, fallbackOptions);
            this.deps.setupAdapterEvents(instanceId, adapter);
            this.deps.setAdapter(instanceId, adapter);

            pid = await adapter.spawn();
            actuallyResumed = false;

            if (hasConversation) {
              await adapter.sendInput(await this.buildFallbackHistory(instance, 'auto-respawn-fallback'));
            }
          } else {
            throw spawnError;
          }
        }
        logger.info('Auto-respawn successful', { instanceId, pid, resumed: actuallyResumed });

        instance.processId = pid;
        this.transitionState(instance, 'idle');
        instance.lastActivity = Date.now();

        if (!actuallyResumed && shouldResume) {
          // Already sent continuity message in fallback path
        } else if (!shouldResume && hasConversation) {
          await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'auto-respawn'));
        }

        const message = {
          id: generateId(),
          type: 'system' as const,
          content: actuallyResumed
            ? 'Session reconnected automatically'
            : 'Session restarted automatically (resume failed)',
          timestamp: Date.now(),
          metadata: { autoRespawn: true }
        };
        this.deps.addToOutputBuffer(instance, message);
        this.emit('output', { instanceId, message });

        this.deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
      } catch (error) {
        logger.error('Auto-respawn failed', error instanceof Error ? error : undefined, { instanceId });
        this.transitionState(instance, 'error');
        instance.processId = null;
        this.deps.queueUpdate(instanceId, 'error');
        throw error;
      }
    } finally {
      release();
    }
  }

  // ============================================
  // Plan Mode Management
  // ============================================

  /**
   * Enter plan mode for an instance
   */
  enterPlanMode(instanceId: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.planMode = {
      enabled: true,
      state: 'planning',
      planContent: undefined,
      approvedAt: undefined
    };

    this.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    logger.info('Entered plan mode', { instanceId });
    return instance;
  }

  /**
   * Exit plan mode
   */
  exitPlanMode(instanceId: string, force = false): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    if (!force && instance.planMode.state !== 'approved') {
      throw new Error('Plan must be approved before exiting plan mode');
    }

    instance.planMode = {
      enabled: false,
      state: 'off',
      planContent: undefined,
      approvedAt: undefined
    };

    this.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    logger.info('Exited plan mode', { instanceId });
    return instance;
  }

  /**
   * Approve a plan in plan mode
   */
  approvePlan(instanceId: string, planContent?: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    instance.planMode = {
      enabled: true,
      state: 'approved',
      planContent: planContent || instance.planMode.planContent,
      approvedAt: Date.now()
    };

    this.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    logger.info('Approved plan', { instanceId });
    return instance;
  }

  /**
   * Update plan content while in planning mode
   */
  updatePlanContent(instanceId: string, planContent: string): Instance {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    instance.planMode.planContent = planContent;

    this.emit('state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    return instance;
  }

  /**
   * Get plan mode state for an instance
   */
  getPlanModeState(instanceId: string): {
    enabled: boolean;
    state: string;
    planContent?: string;
  } {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return {
      enabled: instance.planMode.enabled,
      state: instance.planMode.state,
      planContent: instance.planMode.planContent
    };
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

  private startIdleCheckTimer(): void {
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleInstances();
      this.cleanupZombieProcesses();
    }, 60000);
  }

  private checkIdleInstances(): void {
    const settingsAll = this.settings.getAll();
    const idleMinutes = settingsAll.autoTerminateIdleMinutes;

    if (idleMinutes <= 0) return;

    const idleThreshold = idleMinutes * 60 * 1000;
    const now = Date.now();

    this.deps.forEachInstance((instance) => {
      if (!instance.parentId) return;

      if (
        instance.status === 'idle' &&
        now - instance.lastActivity > idleThreshold
      ) {
        const hasUserMessages = instance.outputBuffer.some(
          (msg) => msg.type === 'user'
        );

        if (hasUserMessages) {
          logger.info('Auto-hibernating idle instance (has conversation)', {
            instanceId: instance.id,
            displayName: instance.displayName,
            idleMinutes
          });
          this.hibernateInstance(instance.id).catch((err) => {
            logger.error('Auto-hibernate failed', err instanceof Error ? err : undefined, {
              instanceId: instance.id
            });
          });
        } else {
          logger.info('Auto-terminating idle instance (no conversation)', {
            instanceId: instance.id,
            displayName: instance.displayName,
            idleMinutes
          });
          void this.terminateInstance(instance.id, true).catch((err) =>
            logger.error('Auto-terminate failed', err instanceof Error ? err : undefined, {
              instanceId: instance.id
            })
          );
        }
      }
    });
  }

  private terminateIdleInstances(): void {
    const idleInstances: Instance[] = [];
    this.deps.forEachInstance((instance) => {
      if (instance.status === 'idle' && instance.parentId) {
        idleInstances.push(instance);
      }
    });

    idleInstances.sort((a, b) => a.lastActivity - b.lastActivity);

    const toTerminate = Math.ceil(idleInstances.length / 2);
    for (let i = 0; i < toTerminate && i < idleInstances.length; i++) {
      logger.warn('Terminating idle instance due to memory pressure', {
        instanceId: idleInstances[i].id,
        displayName: idleInstances[i].displayName
      });
      this.terminateInstance(idleInstances[i].id, true);
    }
  }

  private cleanupZombieProcesses(): void {
    const adapterEntriesToCleanup: string[] = [];

    // First pass: identify adapters to cleanup
    this.deps.forEachInstance((instance, instanceId) => {
      const adapter = this.deps.getAdapter(instanceId);

      if (adapter && (instance.status === 'error' || instance.status === 'terminated')) {
        if (adapter.isRunning()) {
          logger.warn('Found zombie process, force killing', {
            instanceId,
            status: instance.status
          });
          adapterEntriesToCleanup.push(instanceId);
        } else {
          this.deps.deleteAdapter(instanceId);
        }
      }

      if (instance.processId && !this.deps.getAdapter(instanceId)) {
        logger.warn('Instance claims PID but has no adapter, clearing PID', {
          instanceId,
          processId: instance.processId
        });
        instance.processId = null;
        if (instance.status === 'busy' || instance.status === 'initializing') {
          this.transitionState(instance, 'error');
          this.deps.queueUpdate(instanceId, 'error');
        }
      }
    });

    // Second pass: cleanup adapters
    for (const instanceId of adapterEntriesToCleanup) {
      this.forceCleanupAdapter(instanceId).catch((err) => {
        logger.error('Failed to cleanup zombie process', err instanceof Error ? err : undefined, { instanceId });
      });
    }
  }

  private async forceCleanupAdapter(instanceId: string): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) return;

    logger.info('Force cleaning up adapter', { instanceId });

    try {
      await adapter.terminate(false);
    } catch (error) {
      logger.error('Error during force cleanup', error instanceof Error ? error : undefined, { instanceId });
    } finally {
      this.deps.deleteAdapter(instanceId);
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
        this.terminateIdleInstances();
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
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    this.memoryMonitor.stop();
  }
}
