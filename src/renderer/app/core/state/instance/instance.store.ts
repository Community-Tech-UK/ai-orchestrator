/**
 * Instance Store - Angular Signals-based state management
 *
 * This is the main store coordinator that:
 * 1. Injects all sub-stores
 * 2. Sets up IPC listeners and routes events
 * 3. Exposes a unified public API
 * 4. Re-exports queries for consumers
 */

import { Injectable, inject, OnDestroy, signal } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { UpdateBatcherService, StateUpdate } from '../../services/update-batcher.service';
import { ActivityDebouncerService } from '../../services/activity-debouncer.service';
import { generateActivityStatus } from '../../utils/tool-activity-map';

// Sub-stores
import { InstanceStateService } from './instance-state.service';
import { InstanceQueries } from './instance.queries';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';

// Types
import type { InstanceStatus, OutputMessage, CreateInstanceConfig } from './instance.types';
import type { OrchestrationActivityPayload } from '../../../../../shared/types/ipc.types';

@Injectable({ providedIn: 'root' })
export class InstanceStore implements OnDestroy {
  // Inject sub-stores
  private listStore = inject(InstanceListStore);
  private selectionStore = inject(InstanceSelectionStore);
  private outputStore = inject(InstanceOutputStore);
  private messagingStore = inject(InstanceMessagingStore);

  // Inject shared state and queries
  private stateService = inject(InstanceStateService);
  private queries = inject(InstanceQueries);

  // Infrastructure
  private ipc = inject(ElectronIpcService);
  private statsIpc = inject(StatsIpcService);
  private batcher = inject(UpdateBatcherService);
  private activityDebouncer = inject(ActivityDebouncerService);
  private unsubscribes: (() => void)[] = [];

  // Compaction state (tracked per instance)
  private _compactingInstances = signal(new Set<string>());

  // Track when each instance entered 'busy' status (for elapsed time display)
  private _busySince = signal(new Map<string, number>());

  // ============================================
  // Re-export Queries for backwards compatibility
  // ============================================

  readonly instances = this.queries.instances;
  readonly instancesMap = this.queries.instancesMap;
  readonly selectedInstanceId = this.queries.selectedInstanceId;
  readonly selectedInstance = this.queries.selectedInstance;
  readonly loading = this.queries.loading;
  readonly error = this.queries.error;
  readonly instanceCount = this.queries.instanceCount;
  readonly instancesByStatus = this.queries.instancesByStatus;
  readonly totalContextUsage = this.queries.totalContextUsage;
  readonly rootInstances = this.queries.rootInstances;
  readonly selectedInstanceActivity = this.queries.selectedInstanceActivity;
  readonly instanceActivities = this.queries.instanceActivities;

  // ============================================
  // Constructor & Lifecycle
  // ============================================

  constructor() {
    this.setupIpcListeners();
    this.setupBatcher();
    this.listStore.loadInitialInstances();
  }

  ngOnDestroy(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.batcher.destroy();
    this.outputStore.cleanupAll();
  }

  // ============================================
  // Setup Methods
  // ============================================

  private setupIpcListeners(): void {
    // Listen for new instances
    this.unsubscribes.push(
      this.ipc.onInstanceCreated((data) => {
        this.listStore.addInstance(data);
        // Record session start for stats tracking
        const inst = data as { id?: string; sessionId?: string; agentId?: string; workingDirectory?: string };
        if (inst.sessionId && inst.id) {
          this.statsIpc.statsRecordSessionStart(
            inst.sessionId, inst.id, inst.agentId || 'build', inst.workingDirectory || ''
          ).catch(() => { /* stats recording is best-effort */ });
        }
      })
    );

    // Listen for removed instances
    this.unsubscribes.push(
      this.ipc.onInstanceRemoved((instanceId) => {
        this.activityDebouncer.clearActivity(instanceId);
        this.outputStore.cleanupInstance(instanceId);
        this.listStore.removeInstance(instanceId);
      })
    );

    // Listen for state updates (critical ones bypass batching)
    this.unsubscribes.push(
      this.ipc.onInstanceStateUpdate((rawUpdate: unknown) => {
        const update = rawUpdate as StateUpdate;
        if (update.status === 'error' || update.status === 'terminated') {
          this.applyUpdate(update);
        } else {
          this.batcher.queueUpdate(update);
        }
      })
    );

    // Listen for output with activity tracking
    this.unsubscribes.push(
      this.ipc.onInstanceOutput((rawData: unknown) => {
        const data = rawData as { instanceId: string; message: OutputMessage };
        const { instanceId, message } = data;

        // Track tool usage for activity status
        if (message.type === 'tool_use' && message.metadata?.['name']) {
          const toolName = message.metadata['name'] as string;
          const activity = generateActivityStatus(toolName);
          this.activityDebouncer.setActivity(instanceId, activity, toolName);
          // Record tool usage for stats
          const inst = this.stateService.state().instances.get(instanceId);
          if (inst?.sessionId) {
            this.statsIpc.statsRecordToolUsage(inst.sessionId, toolName)
              .catch(() => { /* stats recording is best-effort */ });
          }
        }

        // Queue output with throttling
        this.outputStore.queueOutput(instanceId, message);
      })
    );

    // Listen for batch updates
    this.unsubscribes.push(
      this.ipc.onBatchUpdate((rawData: unknown) => {
        const data = rawData as { updates?: StateUpdate[] };
        if (data.updates) {
          this.batcher.queueUpdates(data.updates);
        }
      })
    );

    // Listen for orchestration activity (child spawn, debate, verification progress)
    this.unsubscribes.push(
      this.ipc.onOrchestrationActivity((rawData: unknown) => {
        const data = rawData as OrchestrationActivityPayload;
        if (data.instanceId && data.activity) {
          this.activityDebouncer.setActivity(
            data.instanceId,
            data.activity,
            `orch:${data.category}`
          );
        }
      })
    );

    // Listen for compaction status updates (auto-compact and manual)
    this.unsubscribes.push(
      this.ipc.onCompactStatus((rawData: unknown) => {
        const data = rawData as { instanceId: string; status: string };
        if (data.status === 'started') {
          this._compactingInstances.update(set => {
            const next = new Set(set);
            next.add(data.instanceId);
            return next;
          });
        } else {
          // completed or error
          this._compactingInstances.update(set => {
            const next = new Set(set);
            next.delete(data.instanceId);
            return next;
          });
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

  // ============================================
  // State Update Methods
  // ============================================

  private applyUpdate(update: StateUpdate): void {
    const newStatus = update.status as InstanceStatus;

    // Clear activity on idle/terminated
    if (newStatus === 'idle' || newStatus === 'terminated') {
      this.activityDebouncer.clearActivity(update.instanceId);
      this.outputStore.flushInstanceOutput(update.instanceId);
    }

    // Record session end for stats tracking on termination
    if (newStatus === 'terminated') {
      const inst = this.stateService.state().instances.get(update.instanceId);
      if (inst?.sessionId) {
        this.statsIpc.statsRecordSessionEnd(inst.sessionId)
          .catch(() => { /* stats recording is best-effort */ });
      }
    }

    // Track busy-since timestamps for elapsed time display
    this.updateBusySince(update.instanceId, newStatus);

    // Update state FIRST so processMessageQueue sees the new status
    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);
      const instance = newMap.get(update.instanceId);

      if (instance) {
        newMap.set(update.instanceId, {
          ...instance,
          status: newStatus || instance.status,
          contextUsage: update.contextUsage || instance.contextUsage,
          lastActivity: Date.now(),
        });
      }

      return { ...current, instances: newMap };
    });

    // Process queued messages AFTER state is updated, so the guard check
    // inside processMessageQueue sees the new 'idle'/'waiting_for_input' status
    if (newStatus === 'idle' || newStatus === 'waiting_for_input') {
      this.messagingStore.processMessageQueue(update.instanceId);
    }
  }

  private applyBatchUpdates(updates: StateUpdate[]): void {
    // Handle activity clearing and busy-since tracking for idle/terminated statuses
    for (const update of updates) {
      const newStatus = update.status as InstanceStatus;
      if (newStatus === 'idle' || newStatus === 'terminated') {
        this.activityDebouncer.clearActivity(update.instanceId);
        this.outputStore.flushInstanceOutput(update.instanceId);
      }
      this.updateBusySince(update.instanceId, newStatus);
    }

    // Update state FIRST so processMessageQueue sees the new statuses
    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);

      for (const update of updates) {
        const instance = newMap.get(update.instanceId);
        if (instance) {
          newMap.set(update.instanceId, {
            ...instance,
            status: (update.status as InstanceStatus) || instance.status,
            contextUsage: update.contextUsage || instance.contextUsage,
            lastActivity: Date.now(),
          });
        }
      }

      return { ...current, instances: newMap };
    });

    // Process queued messages AFTER state is updated, so the guard check
    // inside processMessageQueue sees the new 'idle'/'waiting_for_input' status
    for (const update of updates) {
      const newStatus = update.status as InstanceStatus;
      if (newStatus === 'idle' || newStatus === 'waiting_for_input') {
        this.messagingStore.processMessageQueue(update.instanceId);
      }
    }
  }

  // ============================================
  // Busy-Since Tracking
  // ============================================

  private updateBusySince(instanceId: string, newStatus: InstanceStatus): void {
    this._busySince.update(map => {
      const next = new Map(map);
      if (newStatus === 'busy') {
        // Only set if not already tracking (so we record the initial transition)
        if (!next.has(instanceId)) {
          next.set(instanceId, Date.now());
        }
      } else {
        next.delete(instanceId);
      }
      return next;
    });
  }

  /** Get the timestamp when the selected instance became busy (for elapsed time) */
  getSelectedInstanceBusySince(): number | undefined {
    const id = this.queries.selectedInstanceId();
    if (!id) return undefined;
    return this._busySince().get(id);
  }

  // ============================================
  // Public Actions - Delegation to Sub-stores
  // ============================================

  /** Get instance by ID */
  getInstance(id: string) {
    return this.stateService.getInstance(id);
  }

  /** Set selected instance */
  setSelectedInstance(id: string | null): void {
    this.selectionStore.setSelectedInstance(id);
  }

  /** Create a new instance */
  async createInstance(config: CreateInstanceConfig): Promise<void> {
    return this.listStore.createInstance(config);
  }

  /** Create instance and immediately send a message */
  async createInstanceWithMessage(
    message: string,
    files?: File[],
    workingDirectory?: string,
    provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto',
    model?: string
  ): Promise<boolean> {
    return this.listStore.createInstanceWithMessage(
      message,
      files,
      workingDirectory,
      provider,
      model
    );
  }

  /** Create a child instance */
  async createChildInstance(parentId: string): Promise<void> {
    return this.listStore.createChildInstance(parentId);
  }

  /** Send input to an instance (queues if busy) */
  async sendInput(instanceId: string, message: string, files?: File[]): Promise<void> {
    return this.messagingStore.sendInput(instanceId, message, files);
  }

  /** Terminate an instance */
  async terminateInstance(instanceId: string): Promise<void> {
    return this.listStore.terminateInstance(instanceId);
  }

  /** Interrupt an instance (Ctrl+C equivalent) */
  async interruptInstance(instanceId: string): Promise<void> {
    return this.listStore.interruptInstance(instanceId);
  }

  /** Restart an instance */
  async restartInstance(instanceId: string): Promise<void> {
    return this.listStore.restartInstance(instanceId);
  }

  /** Rename an instance */
  async renameInstance(instanceId: string, displayName: string): Promise<void> {
    return this.listStore.renameInstance(instanceId, displayName);
  }

  /** Terminate all instances */
  async terminateAllInstances(): Promise<void> {
    return this.listStore.terminateAllInstances();
  }

  /** Open folder picker and change working directory for an instance */
  async selectWorkingDirectory(instanceId: string): Promise<void> {
    return this.listStore.selectWorkingDirectory(instanceId);
  }

  /** Set working directory for an instance */
  async setWorkingDirectory(instanceId: string, folder: string): Promise<void> {
    return this.listStore.setWorkingDirectory(instanceId, folder);
  }

  /** Toggle YOLO mode for an instance */
  async toggleYoloMode(instanceId: string): Promise<void> {
    return this.listStore.toggleYoloMode(instanceId);
  }

  /** Change agent mode for an instance */
  async changeAgentMode(instanceId: string, newAgentId: string): Promise<void> {
    return this.listStore.changeAgentMode(instanceId, newAgentId);
  }

  /** Change model for an instance */
  async changeModel(instanceId: string, newModel: string): Promise<void> {
    return this.listStore.changeModel(instanceId, newModel);
  }

  /** Clear error state */
  clearError(): void {
    this.stateService.setError(null);
  }

  /** Set output messages for an instance (used for restoring history) */
  setInstanceMessages(instanceId: string, messages: OutputMessage[]): void {
    this.listStore.setInstanceMessages(instanceId, messages);
  }

  /** Force flush output for an instance (call on completion) */
  flushInstanceOutput(instanceId: string): void {
    this.outputStore.flushInstanceOutput(instanceId);
  }

  /** Get queued message count for an instance (reactive) */
  getQueuedMessageCount(instanceId: string): number {
    return this.messagingStore.getQueuedMessageCount(instanceId);
  }

  /** Get the message queue for an instance (reactive) */
  getMessageQueue(instanceId: string): { message: string; files?: File[] }[] {
    return this.messagingStore.getMessageQueue(instanceId);
  }

  /** Clear the message queue for an instance */
  clearMessageQueue(instanceId: string): void {
    this.messagingStore.clearMessageQueue(instanceId);
  }

  /** Remove a specific message from the queue and return it */
  removeFromQueue(instanceId: string, index: number): { message: string; files?: File[] } | null {
    return this.messagingStore.removeFromQueue(instanceId, index);
  }

  /** Validate files before sending - returns array of error messages */
  validateFiles(files: File[]): string[] {
    return this.listStore.validateFiles(files);
  }

  /** Check if an instance is currently compacting */
  isInstanceCompacting(instanceId: string): boolean {
    return this._compactingInstances().has(instanceId);
  }

  /** Compact context for an instance */
  async compactInstance(instanceId: string): Promise<void> {
    const response = await this.ipc.compactInstance(instanceId);
    if (!response.success) {
      console.error('Compaction failed:', response.error?.message);
    }
  }
}
