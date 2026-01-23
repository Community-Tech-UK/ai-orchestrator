/**
 * Instance Store - Angular Signals-based state management
 */

import {
  Injectable,
  inject,
  signal,
  computed,
  OnDestroy,
  NgZone
} from '@angular/core';
import { ElectronIpcService } from '../services/electron-ipc.service';
import {
  UpdateBatcherService,
  StateUpdate
} from '../services/update-batcher.service';
import { ActivityDebouncerService } from '../services/activity-debouncer.service';
import { generateActivityStatus } from '../utils/tool-activity-map';
import { LIMITS } from '../../../../shared/constants/limits';
import type { AgentMode } from '../../../../shared/types/agent.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';

// Types
export type InstanceStatus =
  | 'initializing'
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'error'
  | 'terminated';

export interface ContextUsage {
  used: number;
  total: number;
  percentage: number;
  costEstimate?: number; // Estimated cost in dollars
}

export interface OutputMessage {
  id: string;
  timestamp: number;
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  /** File attachments for user messages */
  attachments?: FileAttachment[];
}

export type InstanceProvider = 'claude' | 'codex' | 'gemini' | 'ollama' | 'copilot';

export interface Instance {
  id: string;
  displayName: string;
  createdAt: number;
  parentId: string | null;
  childrenIds: string[];
  agentId: string; // Agent profile ID ('build', 'plan', 'review', etc.)
  agentMode: AgentMode; // Agent mode type
  provider: InstanceProvider; // CLI provider being used
  status: InstanceStatus;
  contextUsage: ContextUsage;
  lastActivity: number;
  currentActivity?: string; // Human-readable activity description
  currentTool?: string; // Current tool being used
  sessionId: string;
  workingDirectory: string;
  yoloMode: boolean;
  outputBuffer: OutputMessage[];
}

interface StoreState {
  instances: Map<string, Instance>;
  selectedInstanceId: string | null;
  loading: boolean;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class InstanceStore implements OnDestroy {
  private ipc = inject(ElectronIpcService);
  private batcher = inject(UpdateBatcherService);
  private activityDebouncer = inject(ActivityDebouncerService);
  private ngZone = inject(NgZone);
  private unsubscribes: (() => void)[] = [];

  // Output throttling state
  private outputThrottleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private pendingOutputMessages = new Map<string, OutputMessage[]>();

  // Message queue for when instance is busy (signal for reactivity)
  private messageQueueSignal = signal(
    new Map<string, { message: string; files?: File[] }[]>()
  );

  // Private mutable state
  private state = signal<StoreState>({
    instances: new Map(),
    selectedInstanceId: null,
    loading: false,
    error: null
  });

  // ============================================
  // Public Computed Selectors
  // ============================================

  /** All instances as array */
  readonly instances = computed(() =>
    Array.from(this.state().instances.values())
  );

  /** Instances as Map for direct lookup */
  readonly instancesMap = computed(() => this.state().instances);

  /** Selected instance ID */
  readonly selectedInstanceId = computed(() => this.state().selectedInstanceId);

  /** Selected instance object */
  readonly selectedInstance = computed(() => {
    const id = this.state().selectedInstanceId;
    return id ? this.state().instances.get(id) || null : null;
  });

  /** Loading state */
  readonly loading = computed(() => this.state().loading);

  /** Error state */
  readonly error = computed(() => this.state().error);

  /** Instance count */
  readonly instanceCount = computed(() => this.state().instances.size);

  /** Instances grouped by status */
  readonly instancesByStatus = computed(() => {
    const grouped = new Map<InstanceStatus, Instance[]>();
    for (const instance of this.instances()) {
      const list = grouped.get(instance.status) || [];
      list.push(instance);
      grouped.set(instance.status, list);
    }
    return grouped;
  });

  /** Total context usage across all instances */
  readonly totalContextUsage = computed(() => {
    let used = 0;
    let total = 0;
    let costEstimate = 0;
    for (const instance of this.instances()) {
      used += instance.contextUsage.used;
      total += instance.contextUsage.total;
      costEstimate += instance.contextUsage.costEstimate || 0;
    }
    return {
      used,
      total,
      // Cap at 100% - used can exceed total in long sessions due to context truncation
      percentage: total > 0 ? Math.min((used / total) * 100, 100) : 0,
      costEstimate: costEstimate > 0 ? costEstimate : undefined
    };
  });

  /** Root instances (no parent) */
  readonly rootInstances = computed(() =>
    this.instances().filter((i) => !i.parentId)
  );

  /** Current debounced activity for selected instance */
  readonly selectedInstanceActivity = computed(() => {
    const id = this.state().selectedInstanceId;
    if (!id) return '';
    return this.activityDebouncer.getActivity(id);
  });

  /** Activities map from debouncer (for child panels) */
  readonly instanceActivities = computed(() =>
    this.activityDebouncer.activities()
  );

  /** Get queued message count for an instance (reactive) */
  getQueuedMessageCount(instanceId: string): number {
    return this.messageQueueSignal().get(instanceId)?.length || 0;
  }

  constructor() {
    this.setupIpcListeners();
    this.setupBatcher();
    this.loadInitialInstances();
  }

  ngOnDestroy(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.batcher.destroy();

    // Clean up output throttle timers
    for (const timer of this.outputThrottleTimers.values()) {
      clearTimeout(timer);
    }
    this.outputThrottleTimers.clear();
    this.pendingOutputMessages.clear();
  }

  // ============================================
  // Setup Methods
  // ============================================

  private setupIpcListeners(): void {
    // Listen for new instances
    this.unsubscribes.push(
      this.ipc.onInstanceCreated((data) => {
        this.addInstance(data as Instance);
      })
    );

    // Listen for removed instances
    this.unsubscribes.push(
      this.ipc.onInstanceRemoved((instanceId) => {
        this.removeInstance(instanceId);
      })
    );

    // Listen for state updates (critical ones bypass batching)
    this.unsubscribes.push(
      this.ipc.onInstanceStateUpdate((update: any) => {
        if (update.status === 'error' || update.status === 'terminated') {
          this.applyUpdate(update);
        } else {
          this.batcher.queueUpdate(update);
        }
      })
    );

    // Listen for output with activity tracking
    this.unsubscribes.push(
      this.ipc.onInstanceOutput((data: any) => {
        const { instanceId, message } = data;

        // Track tool usage for activity status
        if (message.type === 'tool_use' && message.metadata?.name) {
          const toolName = message.metadata.name as string;
          const activity = generateActivityStatus(toolName);
          this.activityDebouncer.setActivity(instanceId, activity, toolName);
        }

        // Queue output with throttling
        this.queueOutput(instanceId, message);
      })
    );

    // Listen for batch updates
    this.unsubscribes.push(
      this.ipc.onBatchUpdate((data: any) => {
        if (data.updates) {
          this.batcher.queueUpdates(data.updates);
        }
      })
    );
  }

  private setupBatcher(): void {
    this.unsubscribes.push(
      this.batcher.onFlush((updates) => {
        this.applyBatchUpdates(updates);
      })
    );
  }

  private async loadInitialInstances(): Promise<void> {
    this.state.update((s) => ({ ...s, loading: true }));

    try {
      const response = (await this.ipc.listInstances()) as {
        success: boolean;
        data?: unknown[];
      };
      if (response.success && response.data && Array.isArray(response.data)) {
        const instances = new Map<string, Instance>();
        for (const data of response.data) {
          const item = data as Record<string, unknown>;
          instances.set(item['id'] as string, this.deserializeInstance(item));
        }
        this.state.update((s) => ({
          ...s,
          instances,
          loading: false
        }));
      }
    } catch (error) {
      this.state.update((s) => ({
        ...s,
        loading: false,
        error: 'Failed to load instances'
      }));
    }
  }

  // ============================================
  // State Mutation Methods
  // ============================================

  private addInstance(data: any): void {
    const instance = this.deserializeInstance(data);

    this.state.update((current) => {
      const newMap = new Map(current.instances);
      newMap.set(instance.id, instance);

      // Only auto-select if it's a root instance (not a child)
      // Child instances should not steal focus from the parent
      const shouldAutoSelect = !instance.parentId;

      return {
        ...current,
        instances: newMap,
        loading: false,
        selectedInstanceId: shouldAutoSelect
          ? instance.id
          : current.selectedInstanceId
      };
    });
  }

  private removeInstance(instanceId: string): void {
    // Clean up activity and output state
    this.activityDebouncer.clearActivity(instanceId);
    const timer = this.outputThrottleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.outputThrottleTimers.delete(instanceId);
    }
    this.pendingOutputMessages.delete(instanceId);

    this.state.update((current) => {
      const newMap = new Map(current.instances);
      newMap.delete(instanceId);

      return {
        ...current,
        instances: newMap,
        selectedInstanceId:
          current.selectedInstanceId === instanceId
            ? null
            : current.selectedInstanceId
      };
    });
  }

  private applyUpdate(update: StateUpdate): void {
    const newStatus = update.status as InstanceStatus;

    // Clear activity on idle/terminated
    if (newStatus === 'idle' || newStatus === 'terminated') {
      this.activityDebouncer.clearActivity(update.instanceId);
      this.flushInstanceOutput(update.instanceId);
    }

    // Process queued messages when instance becomes idle or waiting_for_input
    if (newStatus === 'idle' || newStatus === 'waiting_for_input') {
      this.processMessageQueue(update.instanceId);
    }

    this.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(update.instanceId);

      if (instance) {
        newMap.set(update.instanceId, {
          ...instance,
          status: newStatus || instance.status,
          contextUsage: update.contextUsage || instance.contextUsage,
          lastActivity: Date.now()
        });
      }

      return { ...current, instances: newMap };
    });
  }

  private applyBatchUpdates(updates: StateUpdate[]): void {
    // Handle activity clearing for idle/terminated statuses
    for (const update of updates) {
      const newStatus = update.status as InstanceStatus;
      if (newStatus === 'idle' || newStatus === 'terminated') {
        this.activityDebouncer.clearActivity(update.instanceId);
        this.flushInstanceOutput(update.instanceId);
      }
      // Process queued messages when instance becomes idle or waiting_for_input
      if (newStatus === 'idle' || newStatus === 'waiting_for_input') {
        this.processMessageQueue(update.instanceId);
      }
    }

    this.state.update((current) => {
      const newMap = new Map(current.instances);

      for (const update of updates) {
        const instance = newMap.get(update.instanceId);
        if (instance) {
          newMap.set(update.instanceId, {
            ...instance,
            status: (update.status as InstanceStatus) || instance.status,
            contextUsage: update.contextUsage || instance.contextUsage,
            lastActivity: Date.now()
          });
        }
      }

      return { ...current, instances: newMap };
    });
  }

  /**
   * Queue output message with throttling (100ms batches)
   */
  private queueOutput(instanceId: string, message: OutputMessage): void {
    // Add to pending messages
    const pending = this.pendingOutputMessages.get(instanceId) || [];
    pending.push(message);
    this.pendingOutputMessages.set(instanceId, pending);

    // If no timer exists, start one
    if (!this.outputThrottleTimers.has(instanceId)) {
      const timer = setTimeout(() => {
        // Run inside NgZone to trigger Angular change detection
        this.ngZone.run(() => {
          this.flushOutput(instanceId);
        });
      }, LIMITS.TEXT_THROTTLE_MS);
      this.outputThrottleTimers.set(instanceId, timer);
    }
  }

  /**
   * Flush pending output messages for an instance
   * Handles streaming messages by updating existing messages with the same ID
   */
  private flushOutput(instanceId: string): void {
    const pending = this.pendingOutputMessages.get(instanceId);
    if (!pending || pending.length === 0) return;

    // Clear timer and pending
    this.outputThrottleTimers.delete(instanceId);
    this.pendingOutputMessages.delete(instanceId);

    // Apply all pending messages at once
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);

      if (instance) {
        // Start with existing messages
        let outputBuffer = [...instance.outputBuffer];

        // Process each pending message
        for (const msg of pending) {
          const isStreaming = msg.metadata && 'streaming' in msg.metadata && msg.metadata['streaming'] === true;

          if (isStreaming) {
            // For streaming messages, update existing or add new
            const existingIdx = outputBuffer.findIndex(m => m.id === msg.id);
            if (existingIdx >= 0) {
              // Update existing message with accumulated content
              const accumulatedContent = msg.metadata && 'accumulatedContent' in msg.metadata
                ? String(msg.metadata['accumulatedContent'])
                : msg.content;
              outputBuffer[existingIdx] = {
                ...outputBuffer[existingIdx],
                content: accumulatedContent,
                metadata: msg.metadata
              };
            } else {
              // First chunk of this streaming message
              outputBuffer.push(msg);
            }
          } else {
            // Regular message - just append
            outputBuffer.push(msg);
          }
        }

        // Keep buffer trimmed
        const trimmed =
          outputBuffer.length > 1000 ? outputBuffer.slice(-1000) : outputBuffer;

        newMap.set(instanceId, {
          ...instance,
          outputBuffer: trimmed,
          lastActivity: Date.now()
        });
      }

      return { ...current, instances: newMap };
    });
  }

  /**
   * Force flush output for an instance (call on completion)
   */
  flushInstanceOutput(instanceId: string): void {
    const timer = this.outputThrottleTimers.get(instanceId);
    if (timer) {
      clearTimeout(timer);
      this.outputThrottleTimers.delete(instanceId);
    }
    this.flushOutput(instanceId);
  }

  // ============================================
  // Public Actions
  // ============================================

  /** Get instance by ID */
  getInstance(id: string): Instance | undefined {
    return this.state().instances.get(id);
  }

  /** Set selected instance */
  setSelectedInstance(id: string | null): void {
    this.state.update((s) => ({ ...s, selectedInstanceId: id }));
  }

  /** Create a new instance */
  async createInstance(config: {
    workingDirectory?: string;
    displayName?: string;
    parentId?: string;
    yoloMode?: boolean;
    agentId?: string;
    provider?: 'claude' | 'openai' | 'gemini' | 'copilot' | 'auto';
    model?: string;
  }): Promise<void> {
    console.log('InstanceStore: createInstance called with:', config);
    this.state.update((s) => ({ ...s, loading: true }));

    try {
      const result = await this.ipc.createInstance({
        workingDirectory: config.workingDirectory || '.',
        displayName: config.displayName,
        parentInstanceId: config.parentId,
        yoloMode: config.yoloMode,
        agentId: config.agentId,
        provider: config.provider,
        model: config.model
      });
      console.log('InstanceStore: createInstance result:', result);
    } catch (error) {
      console.error('InstanceStore: createInstance error:', error);
      this.state.update((s) => ({
        ...s,
        loading: false,
        error: 'Failed to create instance'
      }));
    }
  }

  /** Create instance and immediately send a message */
  async createInstanceWithMessage(
    message: string,
    files?: File[],
    workingDirectory?: string,
    provider?: 'claude' | 'openai' | 'gemini' | 'copilot' | 'auto',
    model?: string
  ): Promise<void> {
    console.log('InstanceStore: createInstanceWithMessage called with:', {
      message,
      filesCount: files?.length,
      workingDirectory,
      provider,
      model
    });
    this.state.update((s) => ({ ...s, loading: true }));

    try {
      // Convert files to base64 for IPC
      const attachments =
        files && files.length > 0
          ? await Promise.all(files.map((f) => this.fileToAttachment(f)))
          : undefined;

      const result = await this.ipc.createInstanceWithMessage({
        workingDirectory: workingDirectory || '.',
        message,
        attachments,
        provider: provider === 'auto' ? undefined : provider,
        model
      });
      console.log('InstanceStore: createInstanceWithMessage result:', result);
    } catch (error) {
      console.error('InstanceStore: createInstanceWithMessage error:', error);
      this.state.update((s) => ({
        ...s,
        loading: false,
        error: 'Failed to create instance'
      }));
    }
  }

  /** Create a child instance */
  async createChildInstance(parentId: string): Promise<void> {
    const parent = this.getInstance(parentId);
    if (!parent) return;

    await this.createInstance({
      workingDirectory: parent.workingDirectory,
      displayName: `${parent.displayName} > Child`,
      parentId
    });
  }

  /** Send input to an instance (queues if busy) */
  async sendInput(
    instanceId: string,
    message: string,
    files?: File[]
  ): Promise<void> {
    console.log('InstanceStore: sendInput called', {
      instanceId,
      message,
      filesCount: files?.length
    });

    const instance = this.getInstance(instanceId);
    if (!instance) return;

    // If instance is busy, queue the message instead of sending immediately
    if (instance.status === 'busy') {
      console.log('InstanceStore: Instance busy, queuing message');
      this.messageQueueSignal.update((currentMap) => {
        const newMap = new Map(currentMap);
        const queue = newMap.get(instanceId) || [];
        queue.push({ message, files });
        newMap.set(instanceId, queue);
        return newMap;
      });
      return;
    }

    // Send the message immediately
    await this.sendInputImmediate(instanceId, message, files);
  }

  /** Internal method to send input immediately (bypasses queue check) */
  private async sendInputImmediate(
    instanceId: string,
    message: string,
    files?: File[]
  ): Promise<void> {
    // Convert files to base64 for IPC
    const attachments =
      files && files.length > 0
        ? await Promise.all(files.map((f) => this.fileToAttachment(f)))
        : undefined;

    // Optimistically update status
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);
      if (instance) {
        newMap.set(instanceId, { ...instance, status: 'busy' });
      }
      return { ...current, instances: newMap };
    });

    const result = await this.ipc.sendInput(instanceId, message, attachments);
    console.log('InstanceStore: sendInput result', result);

    // If send failed, revert status to idle
    if (!result.success) {
      console.error('InstanceStore: sendInput failed', result.error);
      this.state.update((current) => {
        const newMap = new Map(current.instances);
        const instance = newMap.get(instanceId);
        if (instance && instance.status === 'busy') {
          newMap.set(instanceId, { ...instance, status: 'idle' });
        }
        return { ...current, instances: newMap };
      });
    }
  }

  /** Process queued messages for an instance */
  private processMessageQueue(instanceId: string): void {
    const currentMap = this.messageQueueSignal();
    const queue = currentMap.get(instanceId);
    if (!queue || queue.length === 0) return;

    // Take the first message from the queue
    const nextMessage = queue[0];
    const remainingQueue = queue.slice(1);

    // Update the signal with the new queue state
    this.messageQueueSignal.update((map) => {
      const newMap = new Map(map);
      if (remainingQueue.length === 0) {
        newMap.delete(instanceId);
      } else {
        newMap.set(instanceId, remainingQueue);
      }
      return newMap;
    });

    if (nextMessage) {
      console.log('InstanceStore: Processing queued message', {
        instanceId,
        queueRemaining: remainingQueue.length
      });
      // Use setTimeout to avoid state update conflicts
      setTimeout(() => {
        this.sendInputImmediate(
          instanceId,
          nextMessage.message,
          nextMessage.files
        );
      }, 100);
    }
  }

  /** Clear the message queue for an instance */
  clearMessageQueue(instanceId: string): void {
    this.messageQueueSignal.update((map) => {
      const newMap = new Map(map);
      newMap.delete(instanceId);
      return newMap;
    });
  }

  /** Terminate an instance */
  async terminateInstance(instanceId: string): Promise<void> {
    await this.ipc.terminateInstance(instanceId);
  }

  /** Interrupt an instance (Ctrl+C equivalent) */
  async interruptInstance(instanceId: string): Promise<void> {
    const result = await this.ipc.interruptInstance(instanceId);
    if (result.success) {
      // Optimistically update status to waiting_for_input (Claude is ready for new input)
      this.state.update((current) => {
        const newMap = new Map(current.instances);
        const instance = newMap.get(instanceId);
        if (instance && instance.status === 'busy') {
          newMap.set(instanceId, { ...instance, status: 'waiting_for_input' });
        }
        return { ...current, instances: newMap };
      });
    }
  }

  /** Restart an instance */
  async restartInstance(instanceId: string): Promise<void> {
    const result = await this.ipc.restartInstance(instanceId);
    if (result.success) {
      // Clear the output buffer in the frontend state
      this.state.update((current) => {
        const newMap = new Map(current.instances);
        const instance = newMap.get(instanceId);
        if (instance) {
          newMap.set(instanceId, {
            ...instance,
            outputBuffer: [],
            status: 'idle'
          });
        }
        return { ...current, instances: newMap };
      });
    }
  }

  /** Rename an instance */
  async renameInstance(instanceId: string, displayName: string): Promise<void> {
    // Optimistic update
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);
      if (instance) {
        newMap.set(instanceId, { ...instance, displayName });
      }
      return { ...current, instances: newMap };
    });

    await this.ipc.renameInstance(instanceId, displayName);
  }

  /** Terminate all instances */
  async terminateAllInstances(): Promise<void> {
    await this.ipc.terminateAllInstances();
  }

  /** Open folder picker and change working directory for an instance */
  async selectWorkingDirectory(instanceId: string): Promise<void> {
    const instance = this.getInstance(instanceId);
    if (!instance) return;

    const folder = await this.ipc.selectFolder();
    if (!folder) return; // User cancelled

    // Terminate old instance and create new one with new working directory
    const { displayName, parentId, yoloMode } = instance;

    await this.terminateInstance(instanceId);

    await this.createInstance({
      workingDirectory: folder,
      displayName,
      parentId: parentId || undefined,
      yoloMode
    });
  }

  /** Toggle YOLO mode for an instance (requires restart) */
  async toggleYoloMode(instanceId: string): Promise<void> {
    const instance = this.getInstance(instanceId);
    if (!instance) return;

    // Terminate and recreate with opposite YOLO setting
    const { displayName, parentId, workingDirectory, yoloMode } = instance;

    await this.terminateInstance(instanceId);

    await this.createInstance({
      workingDirectory,
      displayName,
      parentId: parentId || undefined,
      yoloMode: !yoloMode
    });
  }

  /** Change agent mode for an instance (requires restart) */
  async changeAgentMode(instanceId: string, newAgentId: string): Promise<void> {
    const instance = this.getInstance(instanceId);
    if (!instance) return;

    // Don't restart if already in same mode
    if (instance.agentId === newAgentId) return;

    // Terminate and recreate with new agent mode
    const { displayName, parentId, workingDirectory, yoloMode } = instance;

    await this.terminateInstance(instanceId);

    await this.createInstance({
      workingDirectory,
      displayName,
      parentId: parentId || undefined,
      yoloMode,
      agentId: newAgentId
    });
  }

  /** Clear error state */
  clearError(): void {
    this.state.update((s) => ({ ...s, error: null }));
  }

  /** Set output messages for an instance (used for restoring history) */
  setInstanceMessages(instanceId: string, messages: OutputMessage[]): void {
    this.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(instanceId);

      if (instance) {
        newMap.set(instanceId, {
          ...instance,
          outputBuffer: messages
        });
      }

      return { ...current, instances: newMap };
    });
  }

  // ============================================
  // Helpers
  // ============================================

  private deserializeInstance(data: any): Instance {
    return {
      id: data.id,
      displayName: data.displayName,
      createdAt: data.createdAt,
      parentId: data.parentId,
      childrenIds: data.childrenIds || [],
      agentId: data.agentId || 'build',
      agentMode: data.agentMode || 'build',
      provider: data.provider || 'claude',
      status: data.status,
      contextUsage: data.contextUsage || {
        used: 0,
        total: 200000,
        percentage: 0
      },
      lastActivity: data.lastActivity,
      sessionId: data.sessionId,
      workingDirectory: data.workingDirectory,
      yoloMode: data.yoloMode ?? false,
      outputBuffer: data.outputBuffer || []
    };
  }

  private async fileToAttachment(file: File): Promise<{
    name: string;
    type: string;
    size: number;
    data: string;
  }> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          name: file.name,
          type: file.type,
          size: file.size,
          data: reader.result as string
        });
      };
      reader.readAsDataURL(file);
    });
  }
}
