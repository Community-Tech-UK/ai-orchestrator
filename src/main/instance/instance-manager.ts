/**
 * Instance Manager - Manages all Claude Code instances
 */

import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { ClaudeCliAdapter } from '../cli/claude-cli-adapter';
import {
  createCliAdapter,
  resolveCliType,
  getCliDisplayName,
  type UnifiedSpawnOptions,
  type CliAdapter
} from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import { OrchestrationHandler } from '../orchestration/orchestration-handler';
import { generateChildPrompt } from '../orchestration/orchestration-protocol';
import {
  getOutputStorageManager,
  getMemoryMonitor,
  getUnifiedMemory
} from '../memory';
import { getSettingsManager } from '../settings/settings-manager';
import { getHistoryManager } from '../history';
import { RLMContextManager } from '../rlm/context-manager';
import { OutcomeTracker } from '../learning/outcome-tracker';
import { StrategyLearner } from '../learning/strategy-learner';
import { getTaskManager } from '../orchestration/task-manager';
import { getModelRouter, type RoutingDecision } from '../routing';
import type {
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand
} from '../orchestration/orchestration-protocol';
import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  ContextUsage,
  OutputMessage,
  ExportedSession,
  ForkConfig,
  createInstance,
  serializeInstance
} from '../../shared/types/instance.types';
import type {
  InstanceStateUpdatePayload,
  InstanceOutputPayload,
  BatchUpdatePayload
} from '../../shared/types/ipc.types';
import { generateId } from '../../shared/utils/id-generator';
import { LIMITS } from '../../shared/constants/limits';
import { getAgentById, getDefaultAgent } from '../../shared/types/agent.types';
import { getDisallowedTools } from '../../shared/utils/permission-mapper';
import type {
  ContextQuery,
  ContextSection,
  ContextStore
} from '../../shared/types/rlm.types';
import type {
  MemoryType,
  UnifiedRetrievalResult
} from '../../shared/types/unified-memory.types';
import type { TaskExecution } from '../../shared/types/task.types';
import type { ToolUsageRecord } from '../../shared/types/self-improvement.types';

type RlmContextInfo = {
  context: string;
  tokens: number;
  sectionsAccessed: string[];
  durationMs: number;
  source: 'semantic' | 'lexical' | 'hybrid';
};

type ContextBudget = {
  totalTokens: number;
  rlmMaxTokens: number;
  unifiedMaxTokens: number;
  rlmTopK: number;
};

type RankedSection = {
  section: ContextSection;
  score: number;
  semanticScore: number;
  lexicalScore: number;
};

type UnifiedMemoryContextInfo = {
  context: string;
  tokens: number;
  longTermCount: number;
  proceduralCount: number;
  durationMs: number;
};

type FastPathResult = {
  mode: 'grep' | 'files';
  command: string;
  args: string[];
  totalMatches: number;
  lines: string[];
  rawOutput: string;
  cwd: string;
};

export class InstanceManager extends EventEmitter {
  private instances: Map<string, Instance> = new Map();
  private adapters: Map<string, CliAdapter> = new Map();
  private pendingUpdates: Map<string, InstanceStateUpdatePayload> = new Map();
  private batchTimer: NodeJS.Timeout | null = null;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private orchestration: OrchestrationHandler;
  private hasReceivedFirstMessage: Set<string> = new Set();
  private interruptedInstances: Set<string> = new Set(); // Track instances that were interrupted (to respawn on exit)

  // Memory management
  private outputStorage = getOutputStorageManager();
  private memoryMonitor = getMemoryMonitor();
  private settings = getSettingsManager();
  private unifiedMemory = getUnifiedMemory();
  private outcomeTracker = OutcomeTracker.getInstance();
  private strategyLearner = StrategyLearner.getInstance();

  // RLM Context Management
  private rlm: RLMContextManager;
  private instanceRlmStores: Map<string, string> = new Map(); // instanceId -> storeId
  private instanceRlmSessions: Map<string, string> = new Map(); // instanceId -> sessionId

  // RLM Context Configuration - tuned to prevent prompt overflow
  private readonly rlmContextMinChars = 100; // Increased: skip short messages
  private readonly rlmContextMaxTokens = 300; // Reduced from 600: less context injection
  private readonly rlmContextTopK = 2; // Reduced from 4: fewer matches
  private readonly rlmContextMinSimilarity = 0.7; // Increased from 0.6: higher quality matches
  private readonly rlmQueryTimeoutMs = 500; // Reduced from 900: faster timeout
  private readonly contextBudgetMinTokens = 150; // Reduced from 300
  private readonly contextBudgetMaxTokens = 600; // Reduced from 1200: half the max budget
  private readonly rlmHybridSemanticWeight = 0.7;
  private readonly rlmHybridLexicalWeight = 0.3;
  private readonly rlmHybridOverlapBoost = 0.15;
  private readonly rlmSectionSummaryMinTokens = 600;
  private readonly rlmSectionMinTokens = 120;
  private readonly rlmSectionMaxCount = 3; // Reduced from 6: fewer sections
  private readonly toolOutputSummaryMinTokens = 800;
  private readonly unifiedMemoryMinChars = 50; // Increased from 30
  private readonly unifiedMemoryContextMinChars = 80; // Increased from 60
  private readonly unifiedMemoryContextMaxTokens = 250; // Reduced from 500
  private readonly unifiedMemoryQueryTimeoutMs = 400; // Reduced from 700

  constructor() {
    super();
    this.startBatchTimer();
    this.startIdleCheckTimer();
    this.orchestration = new OrchestrationHandler();
    this.rlm = RLMContextManager.getInstance();
    this.setupOrchestrationHandlers();
    this.setupMemoryMonitoring();
    this.configureFromSettings();

    // Listen for settings changes
    this.settings.on('setting-changed', (key: string) => {
      this.configureFromSettings();
    });
  }

  /**
   * Configure from current settings
   */
  private configureFromSettings(): void {
    const settings = this.settings.getAll();

    // Configure memory monitor
    this.memoryMonitor.configure({
      warningThresholdMB: settings.memoryWarningThresholdMB,
      criticalThresholdMB: settings.memoryWarningThresholdMB * 1.5 // 50% above warning
    });

    // Configure output storage
    this.outputStorage.configure({
      maxDiskStorageMB: settings.maxDiskStorageMB
    });
  }

  /**
   * Set up memory monitoring
   */
  private setupMemoryMonitoring(): void {
    this.memoryMonitor.on('warning', (stats) => {
      console.log('Memory warning:', stats);
      this.emit('memory:warning', stats);
    });

    this.memoryMonitor.on('critical', (stats) => {
      console.log('Memory critical:', stats);
      this.emit('memory:critical', stats);

      // Auto-terminate idle instances if enabled
      const settings = this.settings.getAll();
      if (settings.autoTerminateOnMemoryPressure) {
        this.terminateIdleInstances();
      }
    });

    this.memoryMonitor.on('stats', (stats) => {
      this.emit('memory:stats', stats);
    });

    this.memoryMonitor.start();
  }

  /**
   * Start idle instance check timer
   */
  private startIdleCheckTimer(): void {
    // Check every minute for idle instances
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleInstances();
    }, 60000);
  }

  /**
   * Check for and terminate idle instances
   */
  private checkIdleInstances(): void {
    const settings = this.settings.getAll();
    const idleMinutes = settings.autoTerminateIdleMinutes;

    if (idleMinutes <= 0) return; // Disabled

    const idleThreshold = idleMinutes * 60 * 1000; // Convert to ms
    const now = Date.now();

    for (const instance of this.instances.values()) {
      // Only auto-terminate child instances (not root instances)
      if (!instance.parentId) continue;

      // Check if idle
      if (
        instance.status === 'idle' &&
        now - instance.lastActivity > idleThreshold
      ) {
        console.log(
          `Auto-terminating idle instance ${instance.id} (${instance.displayName})`
        );
        this.terminateInstance(instance.id, true);
      }
    }
  }

  /**
   * Terminate idle instances (called on memory pressure)
   */
  private terminateIdleInstances(): void {
    // Sort by last activity (oldest first)
    const idleInstances = Array.from(this.instances.values())
      .filter((i) => i.status === 'idle' && i.parentId) // Only child instances
      .sort((a, b) => a.lastActivity - b.lastActivity);

    // Terminate up to half of idle instances
    const toTerminate = Math.ceil(idleInstances.length / 2);
    for (let i = 0; i < toTerminate && i < idleInstances.length; i++) {
      console.log(
        `Terminating idle instance ${idleInstances[i].id} due to memory pressure`
      );
      this.terminateInstance(idleInstances[i].id, true);
    }
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

  /**
   * Set up orchestration event handlers
   */
  private setupOrchestrationHandlers(): void {
    // Handle spawn child requests
    this.orchestration.on(
      'spawn-child',
      async (parentId: string, command: SpawnChildCommand) => {
        const parent = this.instances.get(parentId);
        if (!parent) return;

        const settings = this.settings.getAll();

        // Check max total instances limit
        if (
          settings.maxTotalInstances > 0 &&
          this.instances.size >= settings.maxTotalInstances
        ) {
          console.log(
            `Cannot spawn child: max total instances (${settings.maxTotalInstances}) reached`
          );
          this.orchestration.notifyError(
            parentId,
            `Cannot spawn child: maximum total instances (${settings.maxTotalInstances}) reached`
          );
          return;
        }

        // Check max children per parent limit
        if (
          settings.maxChildrenPerParent > 0 &&
          parent.childrenIds.length >= settings.maxChildrenPerParent
        ) {
          console.log(
            `Cannot spawn child: max children per parent (${settings.maxChildrenPerParent}) reached`
          );
          this.orchestration.notifyError(
            parentId,
            `Cannot spawn child: maximum children per parent (${settings.maxChildrenPerParent}) reached`
          );
          return;
        }

        try {
          // Generate a temporary ID for the child prompt (actual ID assigned in createInstance)
          const tempChildId = generateId();

          // Create the child with the child-specific prompt prepended to the task
          const childPrompt = generateChildPrompt(
            tempChildId,
            parentId,
            command.task
          );
          const childAgentId = this.resolveChildAgentId(command);

          // Fast-path retrieval: skip spawning a child for simple lookup tasks
          if (await this.tryFastPathRetrieval(parent, command)) {
            return;
          }

          // Use intelligent model routing if no explicit model specified
          const routingDecision = this.routeChildModel(
            command.task,
            command.model,
            childAgentId
          );
          const selectedModel = routingDecision.model;

          console.log(
            `[ModelRouting] Child task routed to ${selectedModel} (${routingDecision.complexity}, ${routingDecision.confidence.toFixed(2)} confidence): ${routingDecision.reason}`
          );
          if (
            routingDecision.estimatedSavingsPercent &&
            routingDecision.estimatedSavingsPercent > 0
          ) {
            console.log(
              `[ModelRouting] Estimated cost savings: ${routingDecision.estimatedSavingsPercent}%`
            );
          }

          // Resolve provider: use command.provider, or inherit from parent, or use settings
          // Map 'codex' to 'openai' for settings compatibility
          const commandProvider =
            command.provider === 'codex' ? 'openai' : command.provider;
          const resolvedProvider = commandProvider || parent.provider || 'auto';

          const child = await this.createInstance({
            workingDirectory:
              command.workingDirectory || parent.workingDirectory,
            displayName: command.name || `Child of ${parent.displayName}`,
            parentId: parentId,
            initialPrompt: childPrompt,
            yoloMode: command.yoloMode === true,
            agentId: childAgentId,
            modelOverride: selectedModel,
            provider: resolvedProvider
          });

          // Mark this child as already having received its first message (the child prompt)
          this.hasReceivedFirstMessage.add(child.id);

          this.orchestration.notifyChildSpawned(
            parentId,
            child.id,
            child.displayName,
            routingDecision
          );
        } catch (error) {
          console.error('Failed to spawn child:', error);
          this.orchestration.notifyError(
            parentId,
            `Failed to spawn child: ${error}`
          );
        }
      }
    );

    // Handle message child requests
    this.orchestration.on(
      'message-child',
      async (parentId: string, command: MessageChildCommand) => {
        try {
          await this.sendInput(command.childId, command.message);
          this.orchestration.notifyMessageSent(parentId, command.childId);
        } catch (error) {
          console.error('Failed to message child:', error);
        }
      }
    );

    // Handle get children requests
    this.orchestration.on(
      'get-children',
      (parentId: string, callback: (children: any[]) => void) => {
        const parent = this.instances.get(parentId);
        if (!parent) {
          callback([]);
          return;
        }

        const children = parent.childrenIds
          .map((childId) => {
            const child = this.instances.get(childId);
            return child
              ? {
                  id: child.id,
                  name: child.displayName,
                  status: child.status,
                  createdAt: child.createdAt
                }
              : null;
          })
          .filter(Boolean);

        callback(children);
      }
    );

    // Handle terminate child requests
    this.orchestration.on(
      'terminate-child',
      async (parentId: string, command: TerminateChildCommand) => {
        try {
          await this.terminateInstance(command.childId, true);
          this.orchestration.notifyChildTerminated(parentId, command.childId);
        } catch (error) {
          console.error('Failed to terminate child:', error);
        }
      }
    );

    // Handle get child output requests
    this.orchestration.on(
      'get-child-output',
      (
        parentId: string,
        command: GetChildOutputCommand,
        callback: (output: string[]) => void
      ) => {
        const child = this.instances.get(command.childId);
        if (!child) {
          callback([]);
          return;
        }

        const lastN = command.lastN || 10;
        const messages = child.outputBuffer.slice(-lastN).map((msg) => {
          return `[${msg.type}] ${msg.content}`;
        });

        callback(messages);
      }
    );

    this.orchestration.on(
      'task-complete',
      (parentId: string, childId: string, task: TaskExecution) => {
        this.recordOrchestrationOutcome(parentId, childId, task, true);
      }
    );

    this.orchestration.on(
      'task-error',
      (
        parentId: string,
        childId: string,
        error: { code: string; message: string }
      ) => {
        const task = this.findTaskForChild(parentId, childId);
        this.recordOrchestrationOutcome(parentId, childId, task, false, error);
      }
    );

    // Handle response injection
    this.orchestration.on(
      'inject-response',
      async (instanceId: string, response: string) => {
        const adapter = this.adapters.get(instanceId);
        const instance = this.instances.get(instanceId);

        if (adapter && instance) {
          // Parse the orchestration response to create a user-friendly message
          // The response format is: [Orchestrator Response]\nAction: xxx\nStatus: xxx\n{json}\n[/Orchestrator Response]
          const actionMatch = response.match(/Action:\s*(\w+)/);
          const statusMatch = response.match(/Status:\s*(\w+)/);
          const action = actionMatch ? actionMatch[1] : 'unknown';
          const status = statusMatch ? statusMatch[1] : 'unknown';

          // Extract the JSON data
          let data: any = {};
          try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              data = JSON.parse(jsonMatch[0]);
            }
          } catch (e) {
            // Ignore parse errors
          }

          // Create a user-friendly message based on the action
          let friendlyContent = '';
          switch (action) {
            case 'spawn_child':
              if (status === 'SUCCESS') {
                friendlyContent = `**Child Spawned:** ${data.name || 'Child instance'}\n\nID: \`${data.childId}\``;
              } else {
                friendlyContent = `**Failed to spawn child:** ${data.error || 'Unknown error'}`;
              }
              break;
            case 'message_child':
              friendlyContent =
                status === 'SUCCESS'
                  ? `**Message sent** to child \`${data.childId}\``
                  : `**Failed to send message:** ${data.error || 'Unknown error'}`;
              break;
            case 'terminate_child':
              friendlyContent =
                status === 'SUCCESS'
                  ? `**Child terminated:** \`${data.childId}\``
                  : `**Failed to terminate child:** ${data.error || 'Unknown error'}`;
              break;
            case 'task_complete':
              friendlyContent = `**Task completed** by child \`${data.childId}\`\n\n${data.result?.summary || data.message || 'No summary'}`;
              break;
            case 'task_progress':
              friendlyContent = `**Progress update** from child \`${data.childId}\`: ${data.progress?.percentage || 0}% - ${data.progress?.currentStep || 'Working...'}`;
              break;
            case 'task_error':
              friendlyContent = `**Error** from child \`${data.childId}\`:\n\n${data.error?.message || data.message || 'Unknown error'}`;
              break;
            case 'get_children':
              if (data.children && data.children.length > 0) {
                const childList = data.children
                  .map(
                    (c: any) => `- **${c.name}** (\`${c.id}\`) - ${c.status}`
                  )
                  .join('\n');
                friendlyContent = `**Active children:**\n\n${childList}`;
              } else {
                friendlyContent = `**No active children**`;
              }
              break;
            case 'get_child_output':
              if (data.output && data.output.length > 0) {
                friendlyContent = `**Output from child \`${data.childId}\`:**\n\n\`\`\`\n${data.output.join('\n')}\n\`\`\``;
              } else {
                friendlyContent = `**No output from child** \`${data.childId}\``;
              }
              break;
            default:
              friendlyContent = `**Orchestration:** ${action} - ${status}`;
          }

          // Add the user-friendly orchestration message to the output buffer
          const orchestrationMessage = {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system' as const,
            content: friendlyContent,
            metadata: { source: 'orchestration', action, status, rawData: data }
          };
          this.addToOutputBuffer(instance, orchestrationMessage);
          this.emit('instance:output', {
            instanceId,
            message: orchestrationMessage
          });

          // Send the original orchestrator response to the Claude CLI (it expects the structured format)
          await adapter.sendInput(response);
        }
      }
    );
  }

  /**
   * Create a new instance
   */
  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    console.log('InstanceManager: Creating instance with config:', config);

    // Resolve agent profile
    const agent = config.agentId
      ? getAgentById(config.agentId)
      : getDefaultAgent();
    const resolvedAgent = agent || getDefaultAgent();

    // Create instance object
    const instance: Instance = {
      id: generateId(),
      displayName: config.displayName || `Instance ${Date.now()}`,
      createdAt: Date.now(),

      parentId: config.parentId || null,
      childrenIds: [],
      supervisorNodeId: '',

      agentId: resolvedAgent.id,
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
      sessionId: config.sessionId || generateId(),
      workingDirectory: config.workingDirectory,
      yoloMode: config.yoloMode ?? false, // Default to YOLO mode
      provider: config.provider || 'auto', // Will be resolved below

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
      console.warn('[Security] YOLO mode enabled for instance', {
        instanceId: instance.id,
        parentId: instance.parentId,
        provider: instance.provider
      });
    }

    // Store instance
    this.instances.set(instance.id, instance);

    // If has parent, update parent's children list
    if (instance.parentId) {
      const parent = this.instances.get(instance.parentId);
      if (parent) {
        parent.childrenIds.push(instance.id);
      }
    }

    // Initialize RLM store and session for this instance
    try {
      const rlmStore = this.rlm.createStore(instance.sessionId);
      this.instanceRlmStores.set(instance.id, rlmStore.id);
      console.log(
        `[RLM] Created store ${rlmStore.id} for session ${instance.sessionId}`
      );

      // Start an RLM session for this instance
      const rlmSession = await this.rlm.startSession(
        rlmStore.id,
        instance.sessionId
      );
      this.instanceRlmSessions.set(instance.id, rlmSession.id);
      console.log(
        `[RLM] Started session ${rlmSession.id} for session ${instance.sessionId}`
      );
    } catch (error) {
      console.error('[RLM] Failed to initialize RLM for instance:', error);
      // Non-fatal - instance can still work without RLM
    }

    // Get disallowed tools based on agent permissions
    const disallowedTools = getDisallowedTools(resolvedAgent.permissions);

    // Resolve CLI provider type
    const settings = this.settings.getAll();
    console.log(
      `[InstanceManager] Requested provider: ${config.provider}, default: ${settings.defaultCli}`
    );
    const resolvedCliType = await resolveCliType(
      config.provider,
      settings.defaultCli
    );
    instance.provider = resolvedCliType as any; // Update with resolved type
    console.log(
      `[InstanceManager] Resolved CLI provider: ${resolvedCliType} (${getCliDisplayName(resolvedCliType)})`
    );

    // Create CLI adapter with agent's system prompt and tool restrictions
    const modelOverride = config.modelOverride || resolvedAgent.modelOverride;
    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: instance.sessionId,
      workingDirectory: config.workingDirectory,
      systemPrompt: resolvedAgent.systemPrompt,
      model: modelOverride,
      yoloMode: instance.yoloMode,
      disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined
    };

    const adapter = createCliAdapter(resolvedCliType, spawnOptions);

    // Set up adapter events
    this.setupAdapterEvents(instance.id, adapter);

    // Store adapter
    this.adapters.set(instance.id, adapter);

    // Spawn the CLI process
    try {
      console.log('InstanceManager: Spawning CLI process for provider:', resolvedCliType);
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
      console.log('InstanceManager: CLI spawned with PID:', pid);

      // Send initial prompt if provided
      if (config.initialPrompt) {
        // Add user message to output buffer so it appears in the conversation
        // The outputBuffer will be included in the 'instance:created' event below
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
        this.addToOutputBuffer(instance, userMessage);

        // Send to adapter
        await adapter.sendInput(config.initialPrompt, config.attachments);
      }
    } catch (error) {
      instance.status = 'error';
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('InstanceManager: Failed to spawn/initialize CLI:', errorMessage);
      console.error('InstanceManager: Full error:', error);

      // Add error message to output buffer so user can see what went wrong
      const errorOutput = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error' as const,
        content: `Failed to initialize ${getCliDisplayName(resolvedCliType)}: ${errorMessage}`
      };
      this.addToOutputBuffer(instance, errorOutput);
    }

    // Register with orchestration handler
    this.orchestration.registerInstance(
      instance.id,
      instance.workingDirectory,
      instance.parentId
    );

    // Emit creation event with serialized instance
    console.log('InstanceManager: Emitting instance:created event');
    this.emit('instance:created', this.serializeForIpc(instance));

    return instance;
  }

  /**
   * Get an instance by ID
   */
  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  /**
   * Get all instances
   */
  getAllInstances(): Instance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get all instances serialized for IPC
   */
  getAllInstancesForIpc(): Record<string, unknown>[] {
    return this.getAllInstances().map((i) => this.serializeForIpc(i));
  }

  /**
   * Get the orchestration handler for event forwarding and user action requests
   */
  getOrchestrationHandler(): OrchestrationHandler {
    return this.orchestration;
  }

  /**
   * Send input to an instance
   */
  async sendInput(
    instanceId: string,
    message: string,
    attachments?: any[]
  ): Promise<void> {
    const instance = this.instances.get(instanceId);
    console.log('InstanceManager: sendInput called', {
      instanceId,
      message: message.substring(0, 50),
      attachmentsCount: attachments?.length ?? 0,
      instanceStatus: instance?.status,
      instanceProvider: instance?.provider,
      attachments: attachments?.map((a) => ({
        name: a.name,
        type: a.type,
        size: a.size,
        hasData: !!a.data
      }))
    });

    const adapter = this.adapters.get(instanceId);
    if (!adapter) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Check if instance is in error state
    if (instance?.status === 'error') {
      throw new Error(`Instance ${instanceId} is in error state and cannot accept input`);
    }
    let rlmContext: RlmContextInfo | null = null;
    let unifiedMemoryContext: UnifiedMemoryContextInfo | null = null;
    const userMessageId = generateId();
    const userMessageTimestamp = Date.now();
    if (instance) {
      instance.requestCount++;
      instance.lastActivity = Date.now();
      const budgets = this.calculateContextBudget(instance, message);

      [rlmContext, unifiedMemoryContext] = await Promise.all([
        this.buildRlmContext(
          instanceId,
          message,
          budgets.rlmMaxTokens,
          budgets.rlmTopK
        ),
        this.buildUnifiedMemoryContext(
          instance,
          message,
          userMessageId,
          budgets.unifiedMaxTokens
        )
      ]);

      if (rlmContext) {
        console.log(
          `[RLM] Injected context for instance ${instanceId}: ${rlmContext.tokens} tokens, ${rlmContext.sectionsAccessed.length} sections, ${rlmContext.durationMs}ms`
        );
      }

      if (unifiedMemoryContext) {
        console.log(
          `[UnifiedMemory] Injected context for instance ${instanceId}: ${unifiedMemoryContext.tokens} tokens, ${unifiedMemoryContext.longTermCount} long-term, ${unifiedMemoryContext.proceduralCount} procedural, ${unifiedMemoryContext.durationMs}ms`
        );
      }

      const metadata: Record<string, unknown> = {};
      if (rlmContext) {
        metadata['rlmContext'] = {
          injected: true,
          tokens: rlmContext.tokens,
          sectionsAccessed: rlmContext.sectionsAccessed,
          durationMs: rlmContext.durationMs,
          source: rlmContext.source
        };
      }
      if (unifiedMemoryContext) {
        metadata['unifiedMemoryContext'] = {
          injected: true,
          tokens: unifiedMemoryContext.tokens,
          longTermCount: unifiedMemoryContext.longTermCount,
          proceduralCount: unifiedMemoryContext.proceduralCount,
          durationMs: unifiedMemoryContext.durationMs
        };
      }

      // Add user message to output buffer (include attachments for display)
      const userMessage = {
        id: userMessageId,
        timestamp: userMessageTimestamp,
        type: 'user' as const,
        content: message,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        // Include attachment metadata for display (but not the full data to save memory)
        attachments: attachments?.map((a) => ({
          name: a.name,
          type: a.type,
          size: a.size,
          data: a.data // Keep data for image thumbnails
        }))
      };
      this.addToOutputBuffer(instance, userMessage);

      // Emit output event so UI sees the user message immediately
      this.emit('instance:output', { instanceId, message: userMessage });
    }

    // Prepend orchestration prompt to first message
    const contextBlocks = [
      this.formatUnifiedMemoryContextBlock(unifiedMemoryContext),
      this.formatRlmContextBlock(rlmContext)
    ].filter(Boolean) as string[];
    const contextBlock =
      contextBlocks.length > 0 ? contextBlocks.join('\n\n') : null;
    let finalMessage = contextBlock ? `${contextBlock}\n\n${message}` : message;
    if (!this.hasReceivedFirstMessage.has(instanceId)) {
      this.hasReceivedFirstMessage.add(instanceId);
      const orchestrationPrompt =
        this.orchestration.getOrchestrationPrompt(instanceId);
      finalMessage = `${orchestrationPrompt}\n\n---\n\n${finalMessage}`;
      console.log('InstanceManager: Injected orchestration prompt');
    }

    console.log('InstanceManager: Sending message to adapter...');
    await adapter.sendInput(finalMessage, attachments);
    console.log('InstanceManager: Message sent to adapter');
  }

  /**
   * Terminate an instance
   */
  async terminateInstance(
    instanceId: string,
    graceful: boolean = true
  ): Promise<void> {
    const adapter = this.adapters.get(instanceId);
    const instance = this.instances.get(instanceId);

    if (adapter) {
      await adapter.terminate(graceful);
      this.adapters.delete(instanceId);
    }

    if (instance) {
      // Archive to history before cleanup (only for root instances with messages)
      if (!instance.parentId && instance.outputBuffer.length > 0) {
        try {
          const history = getHistoryManager();
          const status = instance.status === 'error' ? 'error' : 'completed';
          await history.archiveInstance(instance, status);
        } catch (error) {
          console.error(
            `Failed to archive instance ${instanceId} to history:`,
            error
          );
        }
      }

      instance.status = 'terminated';
      instance.processId = null;

      // Remove from parent's children list
      if (instance.parentId) {
        const parent = this.instances.get(instance.parentId);
        if (parent) {
          parent.childrenIds = parent.childrenIds.filter(
            (id) => id !== instanceId
          );
        }
      }

      // Terminate children
      for (const childId of instance.childrenIds) {
        await this.terminateInstance(childId, graceful);
      }

      // Unregister from orchestration
      this.orchestration.unregisterInstance(instanceId);
      this.hasReceivedFirstMessage.delete(instanceId);

      // End RLM session for this instance
      const rlmSessionId = this.instanceRlmSessions.get(instanceId);
      if (rlmSessionId) {
        try {
          this.rlm.endSession(rlmSessionId);
          console.log(
            `[RLM] Ended session ${rlmSessionId} for instance ${instanceId}`
          );
        } catch (error) {
          console.error(
            `[RLM] Failed to end session for ${instanceId}:`,
            error
          );
        }
        this.instanceRlmSessions.delete(instanceId);
      }
      this.instanceRlmStores.delete(instanceId);

      // Clean up disk storage for this instance
      this.outputStorage.deleteInstance(instanceId).catch((err) => {
        console.error(`Failed to clean up storage for ${instanceId}:`, err);
      });

      this.emit('instance:removed', instanceId);
      this.instances.delete(instanceId);
    }
  }

  /**
   * Restart an instance
   */
  async restartInstance(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Terminate existing adapter
    const oldAdapter = this.adapters.get(instanceId);
    if (oldAdapter) {
      await oldAdapter.terminate(true);
    }

    // Generate a new session ID - Claude CLI doesn't allow reusing session IDs
    const newSessionId = generateId();
    instance.sessionId = newSessionId;

    // Clear the output buffer on restart
    instance.outputBuffer = [];

    // Reset context usage/token counts on restart
    instance.contextUsage = {
      used: 0,
      total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
      percentage: 0
    };
    instance.totalTokensUsed = 0;

    // Reset first message tracking so orchestration prompt gets injected again
    this.hasReceivedFirstMessage.delete(instanceId);

    // Create new adapter with new session ID, using the same provider as before
    const cliType =
      instance.provider === 'auto' || instance.provider === 'openai'
        ? instance.provider === 'openai'
          ? 'codex'
          : 'claude'
        : (instance.provider as CliType);

    const spawnOptions: UnifiedSpawnOptions = {
      sessionId: newSessionId,
      workingDirectory: instance.workingDirectory,
      yoloMode: instance.yoloMode
    };

    const adapter = createCliAdapter(cliType, spawnOptions);

    this.setupAdapterEvents(instanceId, adapter);
    this.adapters.set(instanceId, adapter);

    // Spawn new process
    instance.status = 'initializing';
    instance.restartCount++;

    try {
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
    } catch (error) {
      instance.status = 'error';
      console.error('Failed to restart CLI:', error);
    }

    this.queueUpdate(instanceId, instance.status, instance.contextUsage);
  }

  /**
   * Terminate all instances
   */
  async terminateAll(): Promise<void> {
    const promises = Array.from(this.instances.keys()).map((id) =>
      this.terminateInstance(id, false)
    );
    await Promise.all(promises);
  }

  /**
   * Terminate all instances (alias for IPC)
   */
  async terminateAllInstances(): Promise<void> {
    return this.terminateAll();
  }

  /**
   * Rename an instance
   */
  renameInstance(instanceId: string, displayName: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.displayName = displayName;

    // Emit state update so UI reflects the change
    this.queueUpdate(instanceId, instance.status, instance.contextUsage);
  }

  /**
   * Interrupt an instance (like Ctrl+C)
   * Sends SIGINT to stop Claude's current operation, then respawns with --resume
   */
  interruptInstance(instanceId: string): boolean {
    const adapter = this.adapters.get(instanceId);
    const instance = this.instances.get(instanceId);

    if (!adapter || !instance) {
      console.warn(`Cannot interrupt instance ${instanceId}: not found`);
      return false;
    }

    if (instance.status !== 'busy') {
      console.warn(
        `Cannot interrupt instance ${instanceId}: not busy (status: ${instance.status})`
      );
      return false;
    }

    // Mark this instance as interrupted so we know to respawn it when exit fires
    this.interruptedInstances.add(instanceId);

    const success = adapter.interrupt();
    if (success) {
      // Add a system message to indicate interruption
      const message = {
        id: generateId(),
        type: 'system' as const,
        content: '⚠️ Interrupted by user - resuming session...',
        timestamp: Date.now()
      };
      this.addToOutputBuffer(instance, message);
      this.emit('instance:output', { instanceId, message });

      // Set status to initializing while we respawn
      instance.status = 'initializing';
      instance.lastActivity = Date.now();
      this.queueUpdate(instanceId, 'initializing', instance.contextUsage);
    } else {
      // If interrupt failed, remove from tracking
      this.interruptedInstances.delete(instanceId);
    }

    return success;
  }

  /**
   * Respawn an instance after interrupt to continue the session
   * Uses --resume to maintain conversation history
   */
  private async respawnAfterInterrupt(instanceId: string): Promise<void> {
    console.log(`respawnAfterInterrupt: Starting for instance ${instanceId}`);

    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const sessionId = instance.sessionId;
    console.log(`respawnAfterInterrupt: Session ID = ${sessionId}`);

    if (!sessionId) {
      throw new Error(`Instance ${instanceId} has no session ID to resume`);
    }

    // Create new adapter with --resume and --fork-session to continue conversation
    // with a new session ID (avoids "session already in use" error)
    // Note: Resume/fork features are Claude CLI specific - other providers will just restart fresh
    const newSessionId = generateId();
    instance.sessionId = newSessionId; // Update instance with new session ID

    const cliType =
      instance.provider === 'auto' || instance.provider === 'openai'
        ? instance.provider === 'openai'
          ? 'codex'
          : 'claude'
        : (instance.provider as CliType);

    // For Claude, we can use resume/fork. For others, just restart.
    let adapter: CliAdapter;
    if (cliType === 'claude') {
      adapter = new ClaudeCliAdapter({
        workingDirectory: instance.workingDirectory,
        sessionId: sessionId, // Original session to resume from
        yoloMode: instance.yoloMode,
        resume: true,
        forkSession: true // Creates new session ID while preserving history
      });
    } else {
      // Other CLIs don't support resume, just create fresh adapter
      const spawnOptions: UnifiedSpawnOptions = {
        sessionId: newSessionId,
        workingDirectory: instance.workingDirectory,
        yoloMode: instance.yoloMode
      };
      adapter = createCliAdapter(cliType, spawnOptions);
    }
    this.setupAdapterEvents(instanceId, adapter);
    this.adapters.set(instanceId, adapter);

    // Spawn the new process
    try {
      console.log(`respawnAfterInterrupt: Spawning new process...`);
      const pid = await adapter.spawn();
      console.log(`respawnAfterInterrupt: Process spawned with PID ${pid}`);

      instance.processId = pid;
      instance.status = 'idle';
      instance.lastActivity = Date.now();

      // Add a system message to confirm resumption
      const message = {
        id: generateId(),
        type: 'system' as const,
        content: '✓ Session resumed - ready for input',
        timestamp: Date.now()
      };
      this.addToOutputBuffer(instance, message);
      this.emit('instance:output', { instanceId, message });

      this.queueUpdate(instanceId, 'idle', instance.contextUsage);
      console.log(`respawnAfterInterrupt: Complete, instance is now idle`);
    } catch (error) {
      console.error(`respawnAfterInterrupt: Failed to spawn`, error);
      instance.status = 'error';
      instance.processId = null;
      this.queueUpdate(instanceId, 'error');
      throw error;
    }
  }

  /**
   * Set up event handlers for a CLI adapter
   */
  private setupAdapterEvents(instanceId: string, adapter: CliAdapter): void {
    adapter.on('output', (message: OutputMessage) => {
      const instance = this.instances.get(instanceId);
      if (instance) {
        this.addToOutputBuffer(instance, message);
        this.emit('instance:output', { instanceId, message });

        // Check for orchestration commands in assistant output
        if (message.type === 'assistant' && message.content) {
          this.orchestration.processOutput(instanceId, message.content);
        }
      }
    });

    adapter.on('status', (status: InstanceStatus) => {
      const instance = this.instances.get(instanceId);
      if (instance && instance.status !== status) {
        instance.status = status;
        instance.lastActivity = Date.now();
        this.queueUpdate(instanceId, status, instance.contextUsage);
      }
    });

    adapter.on('context', (usage: ContextUsage) => {
      const instance = this.instances.get(instanceId);
      if (instance) {
        instance.contextUsage = usage;
        instance.totalTokensUsed = usage.used;
        this.queueUpdate(instanceId, instance.status, usage);
      }
    });

    adapter.on('error', (error: Error) => {
      const instance = this.instances.get(instanceId);
      if (instance) {
        instance.errorCount++;
        instance.status = 'error';
        this.queueUpdate(instanceId, 'error');
      }
      console.error(`Instance ${instanceId} error:`, error);
    });

    adapter.on('exit', (code: number | null, signal: string | null) => {
      console.log(
        `Adapter exit event for instance ${instanceId}: code=${code}, signal=${signal}`
      );

      const instance = this.instances.get(instanceId);
      if (!instance) return;

      // Check if this was an interrupted instance that needs respawning
      if (this.interruptedInstances.has(instanceId)) {
        console.log(
          `Instance ${instanceId} was interrupted, will respawn with --resume`
        );
        this.interruptedInstances.delete(instanceId);
        // Respawn the process with --resume to continue the session
        this.respawnAfterInterrupt(instanceId).catch((err) => {
          console.error(
            `Failed to respawn instance ${instanceId} after interrupt:`,
            err
          );
          instance.status = 'error';
          instance.processId = null;
          this.queueUpdate(instanceId, 'error');
        });
        return;
      }

      if (instance.status !== 'terminated') {
        // Unexpected exit - mark as error or terminated
        console.log(
          `Instance ${instanceId} exited unexpectedly, marking as ${code === 0 ? 'terminated' : 'error'}`
        );
        instance.status = code === 0 ? 'terminated' : 'error';
        instance.processId = null;
        this.queueUpdate(instanceId, instance.status);
      }
    });
  }

  /**
   * Add message to instance output buffer
   * For streaming messages (with metadata.streaming=true), updates the existing message
   * with the same ID instead of adding a new one.
   */
  private addToOutputBuffer(instance: Instance, message: OutputMessage): void {
    // Check if this is a streaming message update
    const isStreaming = message.metadata && 'streaming' in message.metadata && message.metadata['streaming'] === true;

    if (isStreaming) {
      // Look for an existing message with the same ID to update
      const existingIndex = instance.outputBuffer.findIndex(m => m.id === message.id);
      if (existingIndex >= 0) {
        // Update the existing message with the accumulated content
        const accumulatedContent = message.metadata && 'accumulatedContent' in message.metadata
          ? String(message.metadata['accumulatedContent'])
          : message.content;
        instance.outputBuffer[existingIndex] = {
          ...instance.outputBuffer[existingIndex],
          content: accumulatedContent,
          metadata: message.metadata
        };
        // Don't run trim/RLM ingestion for streaming updates - just emit for IPC
        this.emit('instance:output', {
          instanceId: instance.id,
          message: instance.outputBuffer[existingIndex]
        });
        return;
      }
      // First streaming chunk for this message ID - add it normally
    }

    instance.outputBuffer.push(message);

    const settings = this.settings.getAll();
    const bufferSize = settings.outputBufferSize;

    // Trim buffer if it exceeds max size
    if (instance.outputBuffer.length > bufferSize) {
      // If disk storage is enabled, save overflow to disk
      if (settings.enableDiskStorage) {
        const overflow = instance.outputBuffer.slice(
          0,
          instance.outputBuffer.length - bufferSize
        );
        this.outputStorage.storeMessages(instance.id, overflow).catch((err) => {
          console.error(
            `Failed to store output to disk for ${instance.id}:`,
            err
          );
        });
      }

      // Keep only the most recent messages in memory
      instance.outputBuffer = instance.outputBuffer.slice(-bufferSize);
    }

    // Ingest message into RLM for context management
    this.ingestToRLM(instance.id, message);
    this.ingestToUnifiedMemory(instance, message);
  }

  /**
   * Ingest a message into RLM context store
   */
  private ingestToRLM(instanceId: string, message: OutputMessage): void {
    const storeId = this.instanceRlmStores.get(instanceId);
    if (!storeId) return; // RLM not initialized for this instance

    // Skip empty content
    if (!message.content || message.content.trim().length === 0) return;

    // Skip very short messages (less than 20 chars) - not worth indexing
    if (message.content.length < 20) return;

    try {
      // Map message type to RLM section type
      let sectionType:
        | 'conversation'
        | 'tool_output'
        | 'file'
        | 'external'
        | 'summary';
      let sectionName: string;

      switch (message.type) {
        case 'user':
          sectionType = 'conversation';
          sectionName = `User message at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'assistant':
          sectionType = 'conversation';
          sectionName = `Assistant response at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'tool_use':
          sectionType = 'tool_output';
          const toolName = message.metadata?.['name'] || 'unknown';
          sectionName = `Tool use: ${toolName}`;
          break;
        case 'tool_result':
          sectionType = 'tool_output';
          sectionName = `Tool result at ${new Date(message.timestamp).toISOString()}`;
          break;
        case 'system':
          // Skip system messages (usually internal notifications)
          return;
        case 'error':
          sectionType = 'external';
          sectionName = `Error at ${new Date(message.timestamp).toISOString()}`;
          break;
        default:
          sectionType = 'external';
          sectionName = `Message at ${new Date(message.timestamp).toISOString()}`;
      }

      const store = this.rlm.getStore(storeId);
      const startOffset = store?.totalSize ?? null;

      // Add section to RLM store
      const section = this.rlm.addSection(
        storeId,
        sectionType,
        sectionName,
        message.content,
        {
          // Additional metadata for better retrieval
          filePath: message.metadata?.['filePath'] as string | undefined,
          language: message.metadata?.['language'] as string | undefined
        }
      );

      if (sectionType === 'tool_output') {
        const newSections =
          store && startOffset !== null
            ? store.sections.filter((entry) => entry.startOffset >= startOffset)
            : [section];
        this.maybeSummarizeToolOutput(instanceId, store, newSections);
      }
    } catch (error) {
      // Log but don't fail - RLM ingestion is non-critical
      console.error(
        `[RLM] Failed to ingest message for instance ${instanceId}:`,
        error
      );
    }
  }

  /**
   * Ingest a message into unified memory (short/long/procedural)
   */
  private ingestToUnifiedMemory(
    instance: Instance,
    message: OutputMessage
  ): void {
    // Skip empty content
    if (!message.content || message.content.trim().length === 0) return;

    // Skip very short messages
    if (message.content.length < this.unifiedMemoryMinChars) return;

    // Skip system messages (usually internal notifications)
    if (message.type === 'system') return;

    const taggedContent = `[instance:${instance.id}] [session:${instance.sessionId}] [${message.type}] ${message.content}`;

    this.unifiedMemory
      .processInput(taggedContent, instance.sessionId, message.id)
      .catch((error) => {
        console.error(
          `[UnifiedMemory] Failed to ingest message for instance ${instance.id}:`,
          error
        );
      });
  }

  private calculateContextBudget(
    instance: Instance,
    message: string
  ): ContextBudget {
    const usagePct = instance.contextUsage?.percentage ?? 0;

    // Skip context injection entirely when context is critically high
    // This prevents "Prompt is too long" errors
    if (usagePct >= 90) {
      console.log(
        `[ContextBudget] Skipping context injection: usage at ${usagePct}%`
      );
      return {
        totalTokens: 0,
        rlmMaxTokens: 0,
        unifiedMaxTokens: 0,
        rlmTopK: 0
      };
    }

    const messageTokens = this.estimateTokens(message);
    const baseBudget = Math.round(
      Math.min(
        this.contextBudgetMaxTokens,
        Math.max(this.contextBudgetMinTokens, messageTokens * 1.0) // Reduced from 1.3
      )
    );

    // More aggressive scaling as context fills up
    const usageMultiplier =
      usagePct >= 80
        ? 0.25 // Very aggressive at 80%+
        : usagePct >= 70
          ? 0.4 // Aggressive at 70%+
          : usagePct >= 60
            ? 0.6 // Moderate at 60%+
            : usagePct >= 50
              ? 0.8 // Light reduction at 50%+
              : 1;

    const totalTokens = Math.max(
      usagePct >= 75 ? 0 : this.contextBudgetMinTokens, // Allow 0 at high usage
      Math.round(baseBudget * usageMultiplier)
    );

    // If budget is too small, skip entirely
    if (totalTokens < 100) {
      return {
        totalTokens: 0,
        rlmMaxTokens: 0,
        unifiedMaxTokens: 0,
        rlmTopK: 0
      };
    }

    const rlmShare =
      messageTokens > 350 ? 0.45 : messageTokens > 150 ? 0.55 : 0.65;
    let rlmMaxTokens = Math.min(
      this.rlmContextMaxTokens,
      Math.round(totalTokens * rlmShare)
    );
    let unifiedMaxTokens = Math.min(
      this.unifiedMemoryContextMaxTokens,
      Math.max(0, totalTokens - rlmMaxTokens)
    );

    if (unifiedMaxTokens < this.rlmSectionMinTokens) {
      rlmMaxTokens = Math.min(
        this.rlmContextMaxTokens,
        rlmMaxTokens + unifiedMaxTokens
      );
      unifiedMaxTokens = 0;
    }

    const rlmTopK = Math.max(
      1, // Allow minimum of 1
      Math.min(this.rlmSectionMaxCount, Math.round(rlmMaxTokens / 150))
    );

    return {
      totalTokens,
      rlmMaxTokens,
      unifiedMaxTokens,
      rlmTopK
    };
  }

  private async buildRlmContext(
    instanceId: string,
    message: string,
    maxTokens: number = this.rlmContextMaxTokens,
    topK: number = this.rlmContextTopK
  ): Promise<RlmContextInfo | null> {
    if (message.trim().length < this.rlmContextMinChars) return null;

    const sessionId = this.instanceRlmSessions.get(instanceId);
    const storeId = this.instanceRlmStores.get(instanceId);
    if (!sessionId || !storeId) return null;

    const store = this.rlm.getStore(storeId);
    if (!store) return null;

    const semanticQuery: ContextQuery = {
      type: 'semantic_search',
      params: {
        query: message,
        topK,
        minSimilarity: this.rlmContextMinSimilarity
      }
    };

    const terms = this.extractQueryTerms(message);
    const lexicalPattern =
      terms.length > 0 ? this.buildLexicalPattern(terms) : '';
    const lexicalQuery: ContextQuery | null = lexicalPattern
      ? {
          type: 'grep',
          params: {
            pattern: lexicalPattern,
            maxResults: Math.max(2, topK)
          }
        }
      : null;

    const startTime = Date.now();

    try {
      const [semanticResult, lexicalResult] = await Promise.all([
        this.withTimeout(
          this.rlm.executeQuery(sessionId, semanticQuery),
          this.rlmQueryTimeoutMs
        ),
        lexicalQuery
          ? this.withTimeout(
              this.rlm.executeQuery(sessionId, lexicalQuery),
              this.rlmQueryTimeoutMs
            )
          : Promise.resolve(null)
      ]);

      const semanticIds = semanticResult?.sectionsAccessed ?? [];
      const lexicalIds = lexicalResult?.sectionsAccessed ?? [];
      const candidateIds = new Set<string>([...semanticIds, ...lexicalIds]);

      if (candidateIds.size === 0) {
        return null;
      }

      const ranked = this.rankRlmSections(
        store,
        candidateIds,
        semanticIds,
        lexicalIds,
        topK
      );
      const payload = this.buildRlmContextPayload(
        ranked,
        store,
        Math.min(maxTokens, this.rlmContextMaxTokens)
      );

      if (!payload.context) return null;

      return {
        context: payload.context,
        tokens: this.estimateTokens(payload.context),
        sectionsAccessed: payload.sectionIds,
        durationMs: Date.now() - startTime,
        source:
          semanticIds.length > 0 && lexicalIds.length > 0
            ? 'hybrid'
            : semanticIds.length > 0
              ? 'semantic'
              : 'lexical'
      };
    } catch (error) {
      console.error(
        `[RLM] Failed to retrieve context for instance ${instanceId}:`,
        error
      );
      return null;
    }
  }

  private formatRlmContextBlock(context: RlmContextInfo | null): string | null {
    if (!context) return null;

    const sourceLabel =
      context.source === 'hybrid'
        ? 'RLM hybrid search'
        : context.source === 'lexical'
          ? 'RLM lexical search'
          : 'RLM semantic search';

    return [
      '[Retrieved Context]',
      `Source: ${sourceLabel}`,
      context.context,
      '[End Retrieved Context]'
    ].join('\n');
  }

  private async buildUnifiedMemoryContext(
    instance: Instance,
    message: string,
    taskId: string,
    maxTokens: number = this.unifiedMemoryContextMaxTokens
  ): Promise<UnifiedMemoryContextInfo | null> {
    if (message.trim().length < this.unifiedMemoryContextMinChars) return null;

    const effectiveMaxTokens = Math.min(
      this.unifiedMemoryContextMaxTokens,
      maxTokens
    );
    if (effectiveMaxTokens <= 0) return null;

    const types: MemoryType[] = ['procedural', 'long_term'];
    const startTime = Date.now();

    try {
      const result = await this.withTimeout(
        this.unifiedMemory.retrieve(message, taskId, {
          types,
          maxTokens: effectiveMaxTokens,
          sessionId: instance.sessionId,
          instanceId: instance.id
        }),
        this.unifiedMemoryQueryTimeoutMs
      );

      if (!result) return null;

      const contextPayload = this.formatUnifiedMemoryPayload(result);
      if (!contextPayload) return null;

      const trimmed = this.trimToTokens(contextPayload, effectiveMaxTokens);
      if (!trimmed) return null;

      return {
        context: trimmed,
        tokens: this.estimateTokens(trimmed),
        longTermCount: result.longTerm.length,
        proceduralCount: result.procedural.length,
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      console.error(
        `[UnifiedMemory] Failed to retrieve context for instance ${instance.id}:`,
        error
      );
      return null;
    }
  }

  private formatUnifiedMemoryPayload(
    result: UnifiedRetrievalResult
  ): string | null {
    const sections: string[] = [];

    if (result.procedural.length > 0) {
      sections.push('Procedural Memory:');
      sections.push(...result.procedural.map((item) => `- ${item}`));
    }

    if (result.longTerm.length > 0) {
      sections.push('Long-term Memory:');
      sections.push(...result.longTerm.map((item) => `- ${item}`));
    }

    if (sections.length === 0) return null;
    return sections.join('\n');
  }

  private extractQueryTerms(message: string): string[] {
    const matches = message.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    const unique = Array.from(
      new Set(matches.filter((term) => term.length >= 4))
    );
    return unique.slice(0, 12);
  }

  private buildLexicalPattern(terms: string[]): string {
    return terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
  }

  private buildRankMap(
    sectionIds: string[],
    topK: number
  ): Map<string, number> {
    const rankMap = new Map<string, number>();
    const denom = Math.max(sectionIds.length, topK, 1);

    sectionIds.forEach((id, index) => {
      const score = Math.max(0.05, (denom - index) / denom);
      rankMap.set(id, score);
    });

    return rankMap;
  }

  private rankRlmSections(
    store: ContextStore,
    candidateIds: Set<string>,
    semanticIds: string[],
    lexicalIds: string[],
    topK: number
  ): RankedSection[] {
    const semanticRank = this.buildRankMap(semanticIds, topK);
    const lexicalRank = this.buildRankMap(lexicalIds, topK);
    const ranked: RankedSection[] = [];

    for (const id of candidateIds) {
      const section = store.sections.find((entry) => entry.id === id);
      if (!section) continue;

      const semanticScore = semanticRank.get(id) ?? 0;
      const lexicalScore = lexicalRank.get(id) ?? 0;
      let score =
        semanticScore * this.rlmHybridSemanticWeight +
        lexicalScore * this.rlmHybridLexicalWeight;

      if (semanticScore > 0 && lexicalScore > 0) {
        score += this.rlmHybridOverlapBoost;
      }

      if (section.type === 'tool_output') {
        score *= 0.85;
      }
      if (section.depth > 0) {
        score *= 0.9;
      }

      ranked.push({ section, score, semanticScore, lexicalScore });
    }

    return ranked.sort((a, b) => b.score - a.score);
  }

  private buildRlmContextPayload(
    ranked: RankedSection[],
    store: ContextStore,
    maxTokens: number
  ): { context: string | null; sectionIds: string[] } {
    if (ranked.length === 0 || maxTokens <= 0) {
      return { context: null, sectionIds: [] };
    }

    const targetCount = Math.min(
      ranked.length,
      Math.max(
        1,
        Math.min(this.rlmSectionMaxCount, Math.round(maxTokens / 220))
      )
    );
    const sectionBudget = Math.max(
      this.rlmSectionMinTokens,
      Math.floor(maxTokens / targetCount)
    );
    const parts: string[] = [];
    const sectionIds: string[] = [];
    let usedTokens = 0;

    for (let index = 0; index < targetCount; index += 1) {
      if (usedTokens >= maxTokens) break;

      const entry = ranked[index];
      if (!entry) break;

      const { content, usedSummary } = this.selectRlmSectionContent(
        store,
        entry.section,
        sectionBudget
      );
      if (!content) continue;

      const label = usedSummary
        ? `${entry.section.type} summary`
        : entry.section.type;
      const source = entry.section.filePath || entry.section.sourceUrl;
      const header = `[Match ${index + 1}] ${entry.section.name}${source ? ` - ${source}` : ''} (${label})`;
      const block = `${header}\n${content}`;
      const blockTokens = this.estimateTokens(block);

      if (parts.length > 0 && usedTokens + blockTokens > maxTokens) {
        break;
      }

      parts.push(block);
      sectionIds.push(entry.section.id);
      usedTokens += blockTokens;
    }

    if (parts.length === 0) {
      return { context: null, sectionIds: [] };
    }

    return {
      context: this.trimToTokens(parts.join('\n\n---\n\n'), maxTokens),
      sectionIds
    };
  }

  private selectRlmSectionContent(
    store: ContextStore,
    section: ContextSection,
    maxTokens: number
  ): { content: string; usedSummary: boolean } {
    let selected = section;
    let usedSummary = false;
    const summaryId = store.summaryIndex?.sectionToSummary.get(section.id);

    if (summaryId) {
      const summary = store.sections.find((entry) => entry.id === summaryId);
      if (
        summary &&
        summary.tokens < section.tokens &&
        (section.tokens > this.rlmSectionSummaryMinTokens ||
          section.tokens > maxTokens)
      ) {
        selected = summary;
        usedSummary = true;
      }
    }

    return {
      content: this.trimToTokens(selected.content, maxTokens),
      usedSummary
    };
  }

  private maybeSummarizeToolOutput(
    instanceId: string,
    store: ContextStore | undefined,
    newSections: ContextSection[]
  ): void {
    if (!store || newSections.length === 0) return;

    const totalTokens = newSections.reduce(
      (sum, section) => sum + section.tokens,
      0
    );
    if (totalTokens < this.toolOutputSummaryMinTokens) return;

    const sessionId = this.instanceRlmSessions.get(instanceId);
    if (!sessionId) return;

    const summaryIndex = store.summaryIndex?.sectionToSummary;
    if (
      summaryIndex &&
      newSections.every((section) => summaryIndex.has(section.id))
    ) {
      return;
    }

    const query: ContextQuery = {
      type: 'summarize',
      params: {
        sectionIds: newSections.map((section) => section.id)
      }
    };

    this.rlm.executeQuery(sessionId, query).catch((error) => {
      console.error(
        `[RLM] Failed to summarize tool output for instance ${instanceId}:`,
        error
      );
    });
  }

  private formatUnifiedMemoryContextBlock(
    context: UnifiedMemoryContextInfo | null
  ): string | null {
    if (!context) return null;

    return [
      '[Unified Memory Context]',
      'Source: Unified Memory',
      context.context,
      '[End Unified Memory Context]'
    ].join('\n');
  }

  private trimToTokens(text: string, maxTokens: number): string {
    if (this.estimateTokens(text) <= maxTokens) return text.trim();

    const maxChars = maxTokens * 4;
    return `${text.slice(0, maxChars).trim()}...`;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T | null> {
    type TimeoutResult =
      | { type: 'timeout' }
      | { type: 'value'; value: T }
      | { type: 'error'; error: unknown };

    let timeoutId: NodeJS.Timeout | undefined;

    const timeout = new Promise<TimeoutResult>((resolve) => {
      timeoutId = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
    });

    const guarded: Promise<TimeoutResult> = promise
      .then((value) => ({ type: 'value', value }) as const)
      .catch((error) => ({ type: 'error', error }) as const);

    const result = await Promise.race([guarded, timeout]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    if (result.type === 'timeout') {
      return null;
    }

    if (result.type === 'error') {
      throw result.error;
    }

    return result.value as T;
  }

  private recordOrchestrationOutcome(
    parentId: string,
    childId: string,
    task: TaskExecution | undefined,
    success: boolean,
    error?: { code: string; message: string }
  ): void {
    const child = this.instances.get(childId);
    const duration =
      task?.startedAt && task?.completedAt
        ? task.completedAt - task.startedAt
        : 0;

    try {
      this.outcomeTracker.recordOutcome({
        instanceId: childId,
        taskType: 'orchestration-task',
        taskDescription: task?.task || error?.message || 'Orchestration task',
        prompt: task?.task || error?.message || 'Orchestration task',
        context: task?.result?.summary,
        agentUsed: child?.agentId || 'unknown',
        modelUsed: 'unknown',
        workflowUsed: task?.name,
        toolsUsed: this.buildToolUsage(child),
        tokensUsed: child?.totalTokensUsed || 0,
        duration,
        success,
        completionScore: success ? 1 : 0,
        errorType: success ? undefined : error?.code,
        errorMessage: success ? undefined : error?.message
      });
    } catch (recordError) {
      console.error(
        `[Learning] Failed to record outcome for task ${task?.taskId || 'unknown'}:`,
        recordError
      );
    }

    this.unifiedMemory.recordTaskOutcome(
      task?.taskId || `${parentId}:${childId}`,
      success,
      success ? 1 : 0
    );
  }

  private findTaskForChild(
    parentId: string,
    childId: string
  ): TaskExecution | undefined {
    const taskManager = getTaskManager();
    const history = taskManager.getTaskHistory(parentId);
    return history.recentTasks.find((task) => task.childId === childId);
  }

  private buildToolUsage(instance?: Instance): ToolUsageRecord[] {
    if (!instance) return [];

    const counts = new Map<string, { count: number }>();

    for (const message of instance.outputBuffer) {
      if (message.type !== 'tool_use') continue;

      const toolName =
        typeof message.metadata?.['name'] === 'string'
          ? (message.metadata?.['name'] as string)
          : 'unknown';
      const entry = counts.get(toolName) || { count: 0 };
      entry.count += 1;
      counts.set(toolName, entry);
    }

    return Array.from(counts.entries()).map(([tool, entry]) => ({
      tool,
      count: entry.count,
      avgDuration: 0,
      errorCount: 0
    }));
  }

  private resolveChildAgentId(command: SpawnChildCommand): string | undefined {
    if (command.agentId) {
      const resolved = getAgentById(command.agentId);
      if (resolved) return command.agentId;
      console.warn(
        `[Orchestration] Unknown agentId "${command.agentId}", using default agent.`
      );
      return undefined;
    }

    if (this.isRetrievalTask(command.task)) {
      const retriever = getAgentById('retriever');
      if (retriever) return retriever.id;
    }

    const recommendation = this.getOutcomeRecommendation(command.task);
    if (recommendation && recommendation.confidence >= 0.6) {
      const recommendedAgentId = this.normalizeRecommendedAgentId(
        recommendation.recommendedAgent
      );
      if (recommendedAgentId) {
        return recommendedAgentId;
      }
    }

    return undefined;
  }

  private isRetrievalTask(task: string): boolean {
    const text = task.toLowerCase();
    const retrievalHints = [
      'find',
      'search',
      'locate',
      'list files',
      'enumerate',
      'identify',
      'where is',
      'grep',
      'ripgrep',
      'rg ',
      'references',
      'reference',
      'usages',
      'usage',
      'occurrences',
      'occurrence',
      'show me',
      'look for',
      'scan',
      'file path',
      'files containing',
      'open file',
      'read file'
    ];
    const changeHints = [
      'implement',
      'modify',
      'edit',
      'refactor',
      'fix',
      'add',
      'remove',
      'create',
      'write',
      'build',
      'update',
      'delete',
      'rename'
    ];

    if (changeHints.some((hint) => text.includes(hint))) {
      return false;
    }

    return retrievalHints.some((hint) => text.includes(hint));
  }

  private isListFilesTask(task: string): boolean {
    const text = task.toLowerCase();
    return (
      text.includes('list files') ||
      text.includes('file list') ||
      text.includes('show files') ||
      text.includes('files in') ||
      text.includes('list directories')
    );
  }

  private classifyTaskType(task: string): string {
    const text = task.toLowerCase();

    if (this.isRetrievalTask(task)) return 'retrieval';
    if (text.includes('security') || text.includes('vulnerability'))
      return 'security-review';
    if (text.includes('review')) return 'review';
    if (text.includes('refactor')) return 'refactor';
    if (text.includes('test') || text.includes('testing')) return 'testing';
    if (text.includes('bug') || text.includes('fix')) return 'bug-fix';
    if (
      text.includes('feature') ||
      text.includes('implement') ||
      text.includes('add')
    )
      return 'feature-development';
    return 'general';
  }

  private getOutcomeRecommendation(task: string) {
    const taskType = this.classifyTaskType(task);
    const recommendation = this.strategyLearner.getRecommendation(
      taskType,
      task
    );
    return { ...recommendation, taskType };
  }

  private normalizeRecommendedAgentId(
    agentId: string | undefined
  ): string | undefined {
    if (!agentId) return undefined;
    if (agentId === 'default') return getDefaultAgent().id;
    const resolved = getAgentById(agentId);
    return resolved ? resolved.id : undefined;
  }

  private shouldUseFastPath(command: SpawnChildCommand): boolean {
    if (command.model || command.agentId) return false;
    if (!this.isRetrievalTask(command.task)) return false;
    return command.task.trim().length <= 220;
  }

  private async tryFastPathRetrieval(
    parent: Instance,
    command: SpawnChildCommand
  ): Promise<boolean> {
    if (!this.shouldUseFastPath(command)) return false;

    const cwd = command.workingDirectory || parent.workingDirectory;
    try {
      const result = await this.runFastPathSearch(command.task, cwd);
      if (!result) return false;

      const summary = this.buildFastPathSummary(command.task, result);
      this.orchestration.notifyFastPathResult(parent.id, {
        summary,
        task: command.task,
        mode: result.mode,
        command: result.command,
        args: result.args,
        totalMatches: result.totalMatches,
        lines: result.lines,
        cwd: result.cwd
      });
      return true;
    } catch (error) {
      console.warn(
        '[FastPath] Retrieval failed, falling back to child instance:',
        error
      );
      return false;
    }
  }

  private async runFastPathSearch(
    task: string,
    cwd: string
  ): Promise<FastPathResult | null> {
    const terms = this.extractQueryTerms(task);
    const pattern = terms.length > 0 ? this.buildLexicalPattern(terms) : '';
    const lineLimit = 40;

    if (this.isListFilesTask(task) || !pattern) {
      const fileList = await this.runFastPathFileList(cwd);
      if (!fileList) return null;
      const filtered =
        terms.length > 0
          ? fileList.files.filter((file) =>
              terms.some((term) => file.toLowerCase().includes(term))
            )
          : fileList.files;
      const lines = filtered.slice(0, lineLimit);
      return {
        mode: 'files',
        command: fileList.command,
        args: fileList.args,
        totalMatches: filtered.length,
        lines,
        rawOutput: filtered.join('\n'),
        cwd
      };
    }

    const result = await this.runFastPathGrep(pattern, cwd);
    if (!result) return null;

    const lines = result.rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, lineLimit);

    return {
      mode: 'grep',
      command: result.command,
      args: result.args,
      totalMatches: result.totalMatches,
      lines,
      rawOutput: result.rawOutput,
      cwd
    };
  }

  private async runFastPathFileList(
    cwd: string
  ): Promise<{ files: string[]; command: string; args: string[] } | null> {
    const gitArgs = ['ls-files'];
    const gitResult = await this.runFastPathCommand('git', gitArgs, cwd, 4000);
    if (gitResult && gitResult.exitCode === 0) {
      const files = gitResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'git', args: gitArgs };
    }

    const findArgs = [
      '.',
      '-maxdepth',
      '3',
      '-type',
      'f',
      '-not',
      '-path',
      '*/node_modules/*',
      '-not',
      '-path',
      '*/.git/*'
    ];
    const findResult = await this.runFastPathCommand(
      'find',
      findArgs,
      cwd,
      5000
    );
    if (findResult && findResult.exitCode === 0) {
      const files = findResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'find', args: findArgs };
    }

    return null;
  }

  private async runFastPathGrep(
    pattern: string,
    cwd: string
  ): Promise<{
    command: string;
    args: string[];
    rawOutput: string;
    totalMatches: number;
  } | null> {
    const rgArgs = ['-n', '--no-heading', '-S', pattern, '.'];
    const rgResult = await this.runFastPathCommand('rg', rgArgs, cwd, 5000);
    if (rgResult && (rgResult.exitCode === 0 || rgResult.exitCode === 1)) {
      const output = rgResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'rg',
        args: rgArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    const gitArgs = ['grep', '-n', '-e', pattern];
    const gitResult = await this.runFastPathCommand('git', gitArgs, cwd, 5000);
    if (gitResult && (gitResult.exitCode === 0 || gitResult.exitCode === 1)) {
      const output = gitResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'git',
        args: gitArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    const grepArgs = [
      '-RIn',
      '--exclude-dir=node_modules',
      '--exclude-dir=.git',
      '-e',
      pattern,
      '.'
    ];
    const grepResult = await this.runFastPathCommand(
      'grep',
      grepArgs,
      cwd,
      5000
    );
    if (
      grepResult &&
      (grepResult.exitCode === 0 || grepResult.exitCode === 1)
    ) {
      const output = grepResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'grep',
        args: grepArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    return null;
  }

  private async runFastPathCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  } | null> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { cwd });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode });
      };

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => finish(code));

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(proc.exitCode ?? null);
      }, timeoutMs);

      proc.on('close', () => clearTimeout(timer));
    });
  }

  private buildFastPathSummary(task: string, result: FastPathResult): string {
    const matchLabel = result.mode === 'files' ? 'files' : 'matches';
    const shown = result.lines.length;
    const total = result.totalMatches;
    const header = `Fast-path retrieval complete (${matchLabel}: ${total}, showing ${shown}).`;
    const commandLine =
      `Command: ${result.command} ${result.args.join(' ')}`.trim();
    const lines =
      result.lines.length > 0 ? result.lines.join('\n') : 'No matches found.';

    return [
      '[Fast Retrieval]',
      header,
      `Task: ${task}`,
      commandLine,
      lines,
      '[End Fast Retrieval]'
    ].join('\n');
  }

  /**
   * Route a child task to the optimal model based on complexity
   *
   * Uses intelligent model routing to select the most cost-effective model:
   * - Simple tasks (file lookups, status checks) -> Haiku (fast/cheap)
   * - Moderate tasks (most development work) -> Sonnet (balanced)
   * - Complex tasks (architecture, security analysis) -> Opus (powerful)
   *
   * This can achieve 40-85% cost savings by routing simple tasks to cheaper models.
   */
  private routeChildModel(
    task: string,
    explicitModel?: string,
    agentId?: string
  ): RoutingDecision {
    const router = getModelRouter();

    if (explicitModel) {
      return router.route(task, explicitModel);
    }

    // If agent has a model override, use that (e.g., retriever uses Haiku)
    if (agentId) {
      const agent = getAgentById(agentId);
      if (agent?.modelOverride) {
        return {
          model: agent.modelOverride,
          complexity: 'simple',
          tier: router.getModelTier(agent.modelOverride),
          confidence: 1.0,
          reason: `Agent "${agent.name}" has model override configured`
        };
      }
    }

    const recommendation = this.getOutcomeRecommendation(task);
    if (
      recommendation &&
      recommendation.confidence >= 0.6 &&
      recommendation.recommendedModel
    ) {
      return {
        model: recommendation.recommendedModel,
        complexity: 'moderate',
        tier: router.getModelTier(recommendation.recommendedModel),
        confidence: recommendation.confidence,
        reason: `Outcome-driven routing for "${recommendation.taskType}"`
      };
    }

    // Use the model router for intelligent selection
    return router.route(task, explicitModel);
  }

  /**
   * Load historical output from disk for an instance
   */
  async loadHistoricalOutput(
    instanceId: string,
    limit?: number
  ): Promise<OutputMessage[]> {
    return this.outputStorage.loadMessages(instanceId, { limit });
  }

  /**
   * Get storage stats for an instance
   */
  getInstanceStorageStats(instanceId: string) {
    return this.outputStorage.getInstanceStats(instanceId);
  }

  /**
   * Queue a state update for batching
   */
  private queueUpdate(
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage
  ): void {
    this.pendingUpdates.set(instanceId, {
      instanceId,
      status,
      contextUsage
    });
  }

  /**
   * Start the batch update timer
   */
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      this.flushUpdates();
    }, LIMITS.OUTPUT_BATCH_INTERVAL_MS);
  }

  /**
   * Flush pending updates to renderer
   */
  private flushUpdates(): void {
    if (this.pendingUpdates.size === 0) return;

    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    const batchPayload: BatchUpdatePayload = {
      updates,
      timestamp: Date.now()
    };

    this.emit('instance:batch-update', batchPayload);
  }

  /**
   * Serialize instance for IPC (convert Maps to Objects)
   */
  private serializeForIpc(instance: Instance): Record<string, unknown> {
    return {
      ...instance,
      communicationTokens: Object.fromEntries(instance.communicationTokens)
    };
  }

  /**
   * Fork an instance at a specific message point
   */
  async forkInstance(config: ForkConfig): Promise<Instance> {
    const sourceInstance = this.instances.get(config.instanceId);
    if (!sourceInstance) {
      throw new Error(`Instance ${config.instanceId} not found`);
    }

    // Determine the message index to fork at
    const forkIndex =
      config.atMessageIndex !== undefined
        ? Math.min(config.atMessageIndex, sourceInstance.outputBuffer.length)
        : sourceInstance.outputBuffer.length;

    // Copy messages up to the fork point
    const forkedMessages = sourceInstance.outputBuffer.slice(0, forkIndex);

    // Create new instance with forked messages
    const forkedInstance = await this.createInstance({
      workingDirectory: sourceInstance.workingDirectory,
      displayName:
        config.displayName || `Fork of ${sourceInstance.displayName}`,
      yoloMode: sourceInstance.yoloMode,
      agentId: sourceInstance.agentId,
      initialOutputBuffer: forkedMessages
    });

    console.log(
      `Forked instance ${sourceInstance.id} at message ${forkIndex} -> ${forkedInstance.id}`
    );

    return forkedInstance;
  }

  /**
   * Export an instance to JSON format
   */
  exportSession(instanceId: string): ExportedSession {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return {
      version: '1.0',
      exportedAt: Date.now(),
      metadata: {
        displayName: instance.displayName,
        createdAt: instance.createdAt,
        workingDirectory: instance.workingDirectory,
        agentId: instance.agentId,
        agentMode: instance.agentMode,
        totalMessages: instance.outputBuffer.length,
        contextUsage: instance.contextUsage
      },
      messages: instance.outputBuffer
    };
  }

  /**
   * Export an instance to Markdown format
   */
  exportSessionMarkdown(instanceId: string): string {
    const session = this.exportSession(instanceId);
    const lines: string[] = [];

    lines.push(`# ${session.metadata.displayName}`);
    lines.push('');
    lines.push(
      `**Created:** ${new Date(session.metadata.createdAt).toLocaleString()}`
    );
    lines.push(`**Working Directory:** ${session.metadata.workingDirectory}`);
    lines.push(
      `**Agent:** ${session.metadata.agentId} (${session.metadata.agentMode})`
    );
    lines.push(`**Messages:** ${session.metadata.totalMessages}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const rolePrefix =
        msg.type === 'user'
          ? '**User**'
          : msg.type === 'assistant'
            ? '**Assistant**'
            : msg.type === 'system'
              ? '_System_'
              : msg.type === 'tool_use'
                ? '`Tool`'
                : msg.type === 'tool_result'
                  ? '`Result`'
                  : '**Error**';

      lines.push(`### ${rolePrefix} (${time})`);
      lines.push('');

      if (msg.type === 'tool_use' && msg.metadata) {
        lines.push(`Using tool: \`${msg.metadata['name'] || 'unknown'}\``);
      } else if (msg.type === 'tool_result') {
        lines.push('```');
        lines.push(
          msg.content.slice(0, 500) + (msg.content.length > 500 ? '...' : '')
        );
        lines.push('```');
      } else {
        lines.push(msg.content);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Import a session from exported JSON
   */
  async importSession(
    session: ExportedSession,
    workingDirectory?: string
  ): Promise<Instance> {
    const instance = await this.createInstance({
      workingDirectory: workingDirectory || session.metadata.workingDirectory,
      displayName: `Imported: ${session.metadata.displayName}`,
      agentId: session.metadata.agentId,
      initialOutputBuffer: session.messages
    });

    console.log(
      `Imported session with ${session.messages.length} messages -> ${instance.id}`
    );

    return instance;
  }

  // ============================================
  // Plan Mode Methods
  // ============================================

  /**
   * Enter plan mode for an instance (read-only exploration)
   */
  enterPlanMode(instanceId: string): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    instance.planMode = {
      enabled: true,
      state: 'planning',
      planContent: undefined,
      approvedAt: undefined
    };

    this.emit('instance:state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    console.log(`Entered plan mode for instance ${instanceId}`);
    return instance;
  }

  /**
   * Exit plan mode (requires approval first)
   */
  exitPlanMode(instanceId: string, force = false): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    // Require approval unless forced
    if (!force && instance.planMode.state !== 'approved') {
      throw new Error('Plan must be approved before exiting plan mode');
    }

    instance.planMode = {
      enabled: false,
      state: 'off',
      planContent: undefined,
      approvedAt: undefined
    };

    this.emit('instance:state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    console.log(`Exited plan mode for instance ${instanceId}`);
    return instance;
  }

  /**
   * Approve a plan in plan mode (allows transition to implementation)
   */
  approvePlan(instanceId: string, planContent?: string): Instance {
    const instance = this.instances.get(instanceId);
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

    this.emit('instance:state-update', {
      instanceId,
      status: instance.status,
      planMode: instance.planMode
    });

    console.log(`Approved plan for instance ${instanceId}`);
    return instance;
  }

  /**
   * Update plan content while in planning mode
   */
  updatePlanContent(instanceId: string, planContent: string): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    if (!instance.planMode.enabled) {
      throw new Error('Instance is not in plan mode');
    }

    instance.planMode.planContent = planContent;

    this.emit('instance:state-update', {
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
    const instance = this.instances.get(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return {
      enabled: instance.planMode.enabled,
      state: instance.planMode.state,
      planContent: instance.planMode.planContent
    };
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
    }
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
    }
    this.memoryMonitor.stop();
    this.terminateAll();
  }
}
