/**
 * Instance Manager - Manages all Claude Code instances
 */

import { EventEmitter } from 'events';
import { ClaudeCliAdapter } from '../cli/claude-cli-adapter';
import { OrchestrationHandler } from '../orchestration/orchestration-handler';
import { generateChildPrompt } from '../orchestration/orchestration-protocol';
import { getOutputStorageManager, getMemoryMonitor } from '../memory';
import { getSettingsManager } from '../settings/settings-manager';
import type { SpawnChildCommand, MessageChildCommand, TerminateChildCommand, GetChildOutputCommand } from '../orchestration/orchestration-protocol';
import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
  ContextUsage,
  OutputMessage,
  createInstance,
  serializeInstance,
} from '../../shared/types/instance.types';
import type {
  InstanceStateUpdatePayload,
  InstanceOutputPayload,
  BatchUpdatePayload,
} from '../../shared/types/ipc.types';
import { generateId } from '../../shared/utils/id-generator';
import { LIMITS } from '../../shared/constants/limits';

export class InstanceManager extends EventEmitter {
  private instances: Map<string, Instance> = new Map();
  private adapters: Map<string, ClaudeCliAdapter> = new Map();
  private pendingUpdates: Map<string, InstanceStateUpdatePayload> = new Map();
  private batchTimer: NodeJS.Timeout | null = null;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  private orchestration: OrchestrationHandler;
  private hasReceivedFirstMessage: Set<string> = new Set();

  // Memory management
  private outputStorage = getOutputStorageManager();
  private memoryMonitor = getMemoryMonitor();
  private settings = getSettingsManager();

  constructor() {
    super();
    this.startBatchTimer();
    this.startIdleCheckTimer();
    this.orchestration = new OrchestrationHandler();
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
      criticalThresholdMB: settings.memoryWarningThresholdMB * 1.5, // 50% above warning
    });

    // Configure output storage
    this.outputStorage.configure({
      maxDiskStorageMB: settings.maxDiskStorageMB,
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
      if (instance.status === 'idle' && (now - instance.lastActivity) > idleThreshold) {
        console.log(`Auto-terminating idle instance ${instance.id} (${instance.displayName})`);
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
      .filter(i => i.status === 'idle' && i.parentId) // Only child instances
      .sort((a, b) => a.lastActivity - b.lastActivity);

    // Terminate up to half of idle instances
    const toTerminate = Math.ceil(idleInstances.length / 2);
    for (let i = 0; i < toTerminate && i < idleInstances.length; i++) {
      console.log(`Terminating idle instance ${idleInstances[i].id} due to memory pressure`);
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
      pressureLevel: this.memoryMonitor.getPressureLevel(),
    };
  }

  /**
   * Set up orchestration event handlers
   */
  private setupOrchestrationHandlers(): void {
    // Handle spawn child requests
    this.orchestration.on('spawn-child', async (parentId: string, command: SpawnChildCommand) => {
      const parent = this.instances.get(parentId);
      if (!parent) return;

      const settings = this.settings.getAll();

      // Check max total instances limit
      if (settings.maxTotalInstances > 0 && this.instances.size >= settings.maxTotalInstances) {
        console.log(`Cannot spawn child: max total instances (${settings.maxTotalInstances}) reached`);
        this.orchestration.notifyError(parentId, `Cannot spawn child: maximum total instances (${settings.maxTotalInstances}) reached`);
        return;
      }

      // Check max children per parent limit
      if (settings.maxChildrenPerParent > 0 && parent.childrenIds.length >= settings.maxChildrenPerParent) {
        console.log(`Cannot spawn child: max children per parent (${settings.maxChildrenPerParent}) reached`);
        this.orchestration.notifyError(parentId, `Cannot spawn child: maximum children per parent (${settings.maxChildrenPerParent}) reached`);
        return;
      }

      try {
        // Generate a temporary ID for the child prompt (actual ID assigned in createInstance)
        const tempChildId = generateId();

        // Create the child with the child-specific prompt prepended to the task
        const childPrompt = generateChildPrompt(tempChildId, parentId, command.task);

        const child = await this.createInstance({
          workingDirectory: command.workingDirectory || parent.workingDirectory,
          displayName: command.name || `Child of ${parent.displayName}`,
          parentId: parentId,
          initialPrompt: childPrompt,
          yoloMode: parent.yoloMode,
        });

        // Mark this child as already having received its first message (the child prompt)
        this.hasReceivedFirstMessage.add(child.id);

        this.orchestration.notifyChildSpawned(parentId, child.id, child.displayName);
      } catch (error) {
        console.error('Failed to spawn child:', error);
        this.orchestration.notifyError(parentId, `Failed to spawn child: ${error}`);
      }
    });

    // Handle message child requests
    this.orchestration.on('message-child', async (parentId: string, command: MessageChildCommand) => {
      try {
        await this.sendInput(command.childId, command.message);
        this.orchestration.notifyMessageSent(parentId, command.childId);
      } catch (error) {
        console.error('Failed to message child:', error);
      }
    });

    // Handle get children requests
    this.orchestration.on('get-children', (parentId: string, callback: (children: any[]) => void) => {
      const parent = this.instances.get(parentId);
      if (!parent) {
        callback([]);
        return;
      }

      const children = parent.childrenIds.map((childId) => {
        const child = this.instances.get(childId);
        return child
          ? {
              id: child.id,
              name: child.displayName,
              status: child.status,
              createdAt: child.createdAt,
            }
          : null;
      }).filter(Boolean);

      callback(children);
    });

    // Handle terminate child requests
    this.orchestration.on('terminate-child', async (parentId: string, command: TerminateChildCommand) => {
      try {
        await this.terminateInstance(command.childId, true);
        this.orchestration.notifyChildTerminated(parentId, command.childId);
      } catch (error) {
        console.error('Failed to terminate child:', error);
      }
    });

    // Handle get child output requests
    this.orchestration.on('get-child-output', (parentId: string, command: GetChildOutputCommand, callback: (output: string[]) => void) => {
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
    });

    // Handle response injection
    this.orchestration.on('inject-response', async (instanceId: string, response: string) => {
      const adapter = this.adapters.get(instanceId);
      if (adapter) {
        // Send the orchestrator response as a system message
        await adapter.sendMessage(response);
      }
    });
  }

  /**
   * Create a new instance
   */
  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    console.log('InstanceManager: Creating instance with config:', config);

    // Create instance object
    const instance: Instance = {
      id: generateId(),
      displayName: config.displayName || `Instance ${Date.now()}`,
      createdAt: Date.now(),

      parentId: config.parentId || null,
      childrenIds: [],
      supervisorNodeId: '',

      status: 'initializing',
      contextUsage: { used: 0, total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS, percentage: 0 },
      lastActivity: Date.now(),

      processId: null,
      sessionId: config.sessionId || generateId(),
      workingDirectory: config.workingDirectory,
      yoloMode: config.yoloMode ?? true,  // Default to YOLO mode

      outputBuffer: [],
      outputBufferMaxSize: LIMITS.OUTPUT_BUFFER_MAX_SIZE,

      communicationTokens: new Map(),
      subscribedTo: [],

      totalTokensUsed: 0,
      requestCount: 0,
      errorCount: 0,
      restartCount: 0,
    };

    // Store instance
    this.instances.set(instance.id, instance);

    // If has parent, update parent's children list
    if (instance.parentId) {
      const parent = this.instances.get(instance.parentId);
      if (parent) {
        parent.childrenIds.push(instance.id);
      }
    }

    // Create CLI adapter
    const adapter = new ClaudeCliAdapter({
      workingDirectory: config.workingDirectory,
      sessionId: instance.sessionId,
      yoloMode: instance.yoloMode,
    });

    // Set up adapter events
    this.setupAdapterEvents(instance.id, adapter);

    // Store adapter
    this.adapters.set(instance.id, adapter);

    // Spawn the CLI process
    try {
      console.log('InstanceManager: Spawning CLI process...');
      const pid = await adapter.spawn();
      instance.processId = pid;
      instance.status = 'idle';
      console.log('InstanceManager: CLI spawned with PID:', pid);

      // Send initial prompt if provided
      if (config.initialPrompt) {
        await adapter.sendMessage(config.initialPrompt, config.attachments);
      }
    } catch (error) {
      instance.status = 'error';
      console.error('InstanceManager: Failed to spawn CLI:', error);
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
   * Send input to an instance
   */
  async sendInput(instanceId: string, message: string, attachments?: any[]): Promise<void> {
    console.log('InstanceManager: sendInput called', {
      instanceId,
      message: message.substring(0, 50),
      attachmentsCount: attachments?.length ?? 0,
      attachments: attachments?.map(a => ({ name: a.name, type: a.type, size: a.size, hasData: !!a.data }))
    });

    const adapter = this.adapters.get(instanceId);
    if (!adapter) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const instance = this.instances.get(instanceId);
    if (instance) {
      instance.requestCount++;
      instance.lastActivity = Date.now();

      // Add user message to output buffer
      const userMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'user' as const,
        content: message,
      };
      this.addToOutputBuffer(instance, userMessage);

      // Emit output event so UI sees the user message immediately
      this.emit('instance:output', { instanceId, message: userMessage });
    }

    // Prepend orchestration prompt to first message
    let finalMessage = message;
    if (!this.hasReceivedFirstMessage.has(instanceId)) {
      this.hasReceivedFirstMessage.add(instanceId);
      const orchestrationPrompt = this.orchestration.getOrchestrationPrompt(instanceId);
      finalMessage = `${orchestrationPrompt}\n\n---\n\n${message}`;
      console.log('InstanceManager: Injected orchestration prompt');
    }

    console.log('InstanceManager: Sending message to adapter...');
    await adapter.sendMessage(finalMessage, attachments);
    console.log('InstanceManager: Message sent to adapter');
  }

  /**
   * Terminate an instance
   */
  async terminateInstance(instanceId: string, graceful: boolean = true): Promise<void> {
    const adapter = this.adapters.get(instanceId);
    const instance = this.instances.get(instanceId);

    if (adapter) {
      await adapter.terminate(graceful);
      this.adapters.delete(instanceId);
    }

    if (instance) {
      instance.status = 'terminated';
      instance.processId = null;

      // Remove from parent's children list
      if (instance.parentId) {
        const parent = this.instances.get(instance.parentId);
        if (parent) {
          parent.childrenIds = parent.childrenIds.filter((id) => id !== instanceId);
        }
      }

      // Terminate children
      for (const childId of instance.childrenIds) {
        await this.terminateInstance(childId, graceful);
      }

      // Unregister from orchestration
      this.orchestration.unregisterInstance(instanceId);
      this.hasReceivedFirstMessage.delete(instanceId);

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

    // Create new adapter
    const adapter = new ClaudeCliAdapter({
      workingDirectory: instance.workingDirectory,
      sessionId: instance.sessionId,
      yoloMode: instance.yoloMode,
    });

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
   * Set up event handlers for a CLI adapter
   */
  private setupAdapterEvents(instanceId: string, adapter: ClaudeCliAdapter): void {
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
      const instance = this.instances.get(instanceId);
      if (instance && instance.status !== 'terminated') {
        // Unexpected exit - mark as error
        instance.status = code === 0 ? 'terminated' : 'error';
        instance.processId = null;
        this.queueUpdate(instanceId, instance.status);
      }
    });
  }

  /**
   * Add message to instance output buffer
   */
  private addToOutputBuffer(instance: Instance, message: OutputMessage): void {
    instance.outputBuffer.push(message);

    const settings = this.settings.getAll();
    const bufferSize = settings.outputBufferSize;

    // Trim buffer if it exceeds max size
    if (instance.outputBuffer.length > bufferSize) {
      // If disk storage is enabled, save overflow to disk
      if (settings.enableDiskStorage) {
        const overflow = instance.outputBuffer.slice(0, instance.outputBuffer.length - bufferSize);
        this.outputStorage.storeMessages(instance.id, overflow).catch((err) => {
          console.error(`Failed to store output to disk for ${instance.id}:`, err);
        });
      }

      // Keep only the most recent messages in memory
      instance.outputBuffer = instance.outputBuffer.slice(-bufferSize);
    }
  }

  /**
   * Load historical output from disk for an instance
   */
  async loadHistoricalOutput(instanceId: string, limit?: number): Promise<OutputMessage[]> {
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
      contextUsage,
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
      timestamp: Date.now(),
    };

    this.emit('instance:batch-update', batchPayload);
  }

  /**
   * Serialize instance for IPC (convert Maps to Objects)
   */
  private serializeForIpc(instance: Instance): Record<string, unknown> {
    return {
      ...instance,
      communicationTokens: Object.fromEntries(instance.communicationTokens),
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
