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
import { getModelsForProvider, isModelTier, looksLikeCodexModelId, resolveModelForTier } from '../../shared/types/provider.types';
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
  OutputMessage
} from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { getPolicyAdapter } from '../observation/policy-adapter';
import { resolveInstructionStack } from '../core/config/instruction-resolver';

const logger = getLogger('InstanceLifecycle');

// Tools that require Claude CLI's interactive terminal and auto-deny in --print mode.
// Always disallow these so Claude doesn't attempt them and misinterpret the auto-denial
// as user rejection. Claude will ask questions as regular text messages instead.
const PRINT_MODE_INCOMPATIBLE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

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
  queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage) => void;
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

  constructor(deps: LifecycleDependencies) {
    super();
    this.deps = deps;
    this.startIdleCheckTimer();
    this.setupMemoryMonitoring();
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

  private extractUnresolvedItems(messages: OutputMessage[]): string[] {
    const unresolved = new Set<string>();

    for (const message of messages.slice(-30)) {
      const todoMatches = message.content.match(/- \[ \]\s+(.+)/gi);
      if (todoMatches) {
        for (const match of todoMatches) {
          unresolved.add(match.replace(/^- \[ \]\s+/i, '').trim());
        }
      }

      const todoLineMatches = message.content.match(/(?:^|\n)\s*(?:todo|next|follow-up)\s*[:-]\s*(.+)/gi);
      if (todoLineMatches) {
        for (const match of todoLineMatches) {
          unresolved.add(match.replace(/(?:^|\n)\s*(?:todo|next|follow-up)\s*[:-]\s*/i, '').trim());
        }
      }
    }

    return Array.from(unresolved).filter(Boolean).slice(0, 5);
  }

  private buildReplayContinuityMessage(instance: Instance, reason: string): string {
    const userAndAssistant = instance.outputBuffer
      .filter((message) => message.type === 'user' || message.type === 'assistant')
      .slice(-8);

    const recentTurns = userAndAssistant.map((message) => {
      const role = message.type === 'user' ? 'User' : 'Assistant';
      const content = message.content.length > 400
        ? `${message.content.slice(0, 400)}...[truncated]`
        : message.content;
      return `- ${role}: ${content}`;
    });

    const latestUserMessage = [...instance.outputBuffer]
      .reverse()
      .find((message) => message.type === 'user');
    const currentObjective = latestUserMessage?.content || 'Continue the previous task.';
    const unresolvedItems = this.extractUnresolvedItems(instance.outputBuffer);

    const unresolvedSection = unresolvedItems.length > 0
      ? unresolvedItems.map(item => `- ${item}`).join('\n')
      : '- None explicitly captured.';

    return [
      '[SYSTEM CONTINUITY NOTICE]',
      `Native resume is unavailable for this provider. Continuity mode is replay-based (${reason}).`,
      '',
      'Current objective:',
      currentObjective,
      '',
      'Unresolved items:',
      unresolvedSection,
      '',
      'Recent conversation:',
      recentTurns.length > 0 ? recentTurns.join('\n') : '- No recent turns available.',
      '',
      'Continue from this state and ask for clarification only if essential context is missing.',
      '[END CONTINUITY NOTICE]',
    ].join('\n');
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
   * Create a new instance
   */
  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    logger.info('Creating instance', { config });
    const sessionId = config.sessionId || generateId();
    const historyThreadId = config.historyThreadId || sessionId;

    // Resolve agent profile (built-in + optional markdown-defined)
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
    let resolvedYoloMode = config.yoloMode ?? false;
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

      outputBuffer: config.initialOutputBuffer || [],
      outputBufferMaxSize: LIMITS.OUTPUT_BUFFER_MAX_SIZE,

      communicationTokens: new Map(),
      subscribedTo: [],

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

    // Store instance
    this.deps.setInstance(instance);

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

    // Initialize RLM
    await this.deps.initializeRlm(instance);

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
      workingDirectory: config.workingDirectory,
      systemPrompt: systemPrompt,
      model: modelOverride,
      yoloMode: instance.yoloMode,
      allowedTools: defaultAllowedTools,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      resume: config.resume,
      mcpConfig: this.getMcpConfig(),
    };

    const adapter = createCliAdapter(resolvedCliType, spawnOptions);

    // Set up adapter events
    this.deps.setupAdapterEvents(instance.id, adapter);

    // Store adapter
    this.deps.setAdapter(instance.id, adapter);

    // Spawn the CLI process
    try {
      logger.info('Spawning CLI process', { provider: resolvedCliType });
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
      logger.info('CLI spawned successfully', { pid, instanceId: instance.id });

      // Send initial prompt if provided
      if (config.initialPrompt) {
        const userMessage = {
          id: generateId(),
          timestamp: Date.now(),
          type: 'user' as const,
          content: config.initialPrompt,
          attachments: config.attachments?.map((a) => ({
            name: a.name,
            type: a.type,
            size: a.size,
            data: a.data
          }))
        };
        this.deps.addToOutputBuffer(instance, userMessage);
        await adapter.sendInput(config.initialPrompt, config.attachments);
      }
    } catch (error) {
      instance.status = 'error';
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Failed to spawn/initialize CLI', error instanceof Error ? error : undefined, { errorMessage });

      const errorOutput = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error' as const,
        content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
      };
      this.deps.addToOutputBuffer(instance, errorOutput);
    }

    // Register with orchestration handler
    this.deps.registerOrchestration(
      instance.id,
      instance.workingDirectory,
      instance.parentId
    );

    // Emit creation event
    logger.debug('Emitting instance:created event', { instanceId: instance.id });
    this.emit('created', this.deps.serializeForIpc(instance));

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

      instance.status = 'terminated';
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
      total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
      percentage: 0
    };
    instance.totalTokensUsed = 0;

    // Reset first message tracking
    this.deps.clearFirstMessageTracking(instanceId);

    // Create new adapter
    const cliType = await this.resolveCliTypeForInstance(instance);

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

    // Spawn new process
    instance.status = 'initializing';
    instance.restartCount++;

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
    } catch (error) {
      instance.status = 'error';
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
    instance.status = 'initializing';

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

    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: instance.sessionId,
      workingDirectory: instance.workingDirectory,
      systemPrompt: newAgent.systemPrompt,
      yoloMode: instance.yoloMode,
      model: instance.currentModel,
      allowedTools: defaultAllowedTools,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      resume: shouldResume,
      mcpConfig: this.getMcpConfig(),
    };

    const adapter = createCliAdapter(cliType, spawnOptions);

    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
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
      instance.status = 'error';
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
    instance.status = 'initializing';

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

    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: instance.sessionId,
      workingDirectory: instance.workingDirectory,
      systemPrompt: agent.systemPrompt,
      yoloMode: newYoloMode,
      allowedTools,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      // Only resume if there's actually a conversation to continue
      resume: shouldResume,
      mcpConfig: this.getMcpConfig(),
    };
    logger.debug('Spawn options configured', {
      instanceId,
      resume: spawnOptions.resume,
      sessionId: spawnOptions.sessionId
    });

    const adapter = createCliAdapter(cliType, spawnOptions);

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
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
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
      instance.status = 'error';
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
    instance.currentModel = newModel;
    instance.status = 'initializing';

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

    // Validate model against provider before passing it
    let validatedModel: string | undefined = newModel;
    if (cliType !== 'claude') {
      const providerModels = getModelsForProvider(cliType);
      const allowCodexDynamicModel = cliType === 'codex' && looksLikeCodexModelId(newModel);
      if (providerModels.length > 0 && !providerModels.some(m => m.id === newModel) && !allowCodexDynamicModel) {
        logger.warn('Model not valid for target provider during changeModel, using provider default', {
          model: newModel,
          provider: cliType,
          fallbackModel: 'provider-default',
        });
        validatedModel = undefined;
      }
    }

    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: instance.sessionId,
      workingDirectory: instance.workingDirectory,
      systemPrompt: agent.systemPrompt,
      model: validatedModel,
      yoloMode: instance.yoloMode,
      allowedTools,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
      resume: shouldResume,
      mcpConfig: this.getMcpConfig(),
    };

    const adapter = createCliAdapter(cliType, spawnOptions);
    this.deps.setupAdapterEvents(instanceId, adapter);
    this.deps.setAdapter(instanceId, adapter);

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
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
      instance.status = 'error';
      logger.error('Failed to change model', error instanceof Error ? error : undefined, { instanceId, newModel });
      throw error;
    }

    this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
    this.emit('model-changed', {
      instanceId,
      model: newModel
    });

    return instance;
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
      instance.status = 'respawning';
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
      const pid = await adapter.spawn();
      logger.info('Process respawned successfully', { instanceId, pid });

      instance.processId = pid;
      instance.status = 'idle';
      instance.lastActivity = Date.now();

      if (!shouldResume && hasConversation) {
        await adapter.sendInput(this.buildReplayContinuityMessage(instance, 'interrupt-respawn'));
      }

      const message = {
        id: generateId(),
        type: 'system' as const,
        content: 'Interrupted — waiting for input',
        timestamp: Date.now()
      };
      this.deps.addToOutputBuffer(instance, message);
      this.emit('output', { instanceId, message });

      this.deps.queueUpdate(instanceId, 'idle', instance.contextUsage);
      logger.info('Respawn after interrupt complete', { instanceId });
    } catch (error) {
      logger.error('Failed to spawn after interrupt', error instanceof Error ? error : undefined, { instanceId });
      instance.status = 'error';
      instance.processId = null;
      this.deps.queueUpdate(instanceId, 'error');
      throw error;
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
    this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
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
        logger.info('Auto-terminating idle instance', {
          instanceId: instance.id,
          displayName: instance.displayName,
          idleMinutes
        });
        this.terminateInstance(instance.id, true);
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
          instance.status = 'error';
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

      const settingsAll = this.settings.getAll();
      if (settingsAll.autoTerminateOnMemoryPressure) {
        this.terminateIdleInstances();
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
