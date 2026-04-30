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
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
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
import type { InstanceStatus, CreateInstanceConfig, OutputMessage } from './instance.types';
import type { CreateInstanceWithMessageOptions } from './instance-list.store';
import type { HistoryRestoreMode } from '../../../../../shared/types/history.types';

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
  private instanceIpc = inject(InstanceIpcService);
  private eventBus = inject(IpcEventBusService);
  private statsIpc = inject(StatsIpcService);
  private batcher = inject(UpdateBatcherService);
  private activityDebouncer = inject(ActivityDebouncerService);
  private unsubscribes: (() => void)[] = [];

  // Compaction state (tracked per instance)
  private _compactingInstances = signal(new Set<string>());

  // Track when each instance entered 'busy' status (for elapsed time display)
  private _busySince = signal(new Map<string, number>());

  // Respawn timeout watchdog: force-terminates instances stuck in 'respawning'
  private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly RESPAWN_TIMEOUT_MS = 15_000;

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

    // Clean up respawn watchdog timers
    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
  }

  // ============================================
  // Setup Methods
  // ============================================

  private setupIpcListeners(): void {
    this.addSubscription(
      this.eventBus.instanceCreated$.subscribe((data) => {
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
    this.addSubscription(
      this.eventBus.instanceRemoved$.subscribe((instanceId) => {
        this.activityDebouncer.clearActivity(instanceId);
        this.outputStore.cleanupInstance(instanceId);
        this.listStore.removeInstance(instanceId);
      })
    );
    this.addSubscription(
      this.eventBus.instanceStateUpdate$.subscribe((update) => {
        if (update.status === 'error' || update.status === 'terminated') {
          this.applyUpdate(update);
        } else {
          this.batcher.queueUpdate(update);
        }
      })
    );
    this.addSubscription(
      this.eventBus.instanceOutput$.subscribe(({ instanceId, message }) => {

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
    this.addSubscription(
      this.eventBus.batchUpdate$.subscribe((data) => {
        if (data.updates) {
          this.batcher.queueUpdates(data.updates);
        }
      })
    );
    this.addSubscription(
      this.eventBus.orchestrationActivity$.subscribe((data) => {
        if (data.instanceId && data.activity) {
          this.activityDebouncer.setActivity(
            data.instanceId,
            data.activity,
            `orch:${data.category}`
          );
        }
      })
    );
    this.addSubscription(
      this.eventBus.compactStatus$.subscribe((data) => {
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
    this.addSubscription(
      this.eventBus.inputRequired$.subscribe((payload) => {
        if (payload.instanceId) {
          // Check if YOLO mode is enabled — skip tracking if so
          const inst = this.stateService.getInstance(payload.instanceId);
          if (inst?.yoloMode) return;

          this.stateService.updateInstance(payload.instanceId, {
            pendingApprovalCount: (inst?.pendingApprovalCount ?? 0) + 1,
          });
        }
      })
    );
  }

  private addSubscription(subscription: { unsubscribe(): void }): void {
    this.unsubscribes.push(() => subscription.unsubscribe());
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
    const newStatus = update.status as InstanceStatus | undefined;

    // Read previous status BEFORE applying update
    const instance = this.stateService.getInstance(update.instanceId);
    const previousStatus = instance?.status;

    // Clear activity on idle/ready/terminated/hibernated
    if (newStatus === 'idle' || newStatus === 'ready' || newStatus === 'terminated' || newStatus === 'hibernated') {
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
    if (newStatus) {
      this.updateBusySince(update.instanceId, newStatus);

      // Track respawn timeouts — force-terminate if stuck
      this.updateRespawnWatchdog(update.instanceId, newStatus);
    }

    // Clear pending approval count when instance resumes work or is terminated
    if (newStatus === 'busy' || newStatus === 'terminated') {
      this.clearPendingApprovals(update.instanceId);
    }

    // Update state FIRST so processMessageQueue sees the new status
    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);
      const inst = newMap.get(update.instanceId);

      if (inst) {
        newMap.set(update.instanceId, {
            ...inst,
            status: newStatus || inst.status,
            activityState: update.activityState ?? inst.activityState,
            contextUsage: update.contextUsage || inst.contextUsage,
            lastActivity: Date.now(),
            metadata: newStatus
              ? this.withStatusTimeline(inst.metadata, newStatus, Date.now())
              : inst.metadata,
          diffStats:
            update.diffStats !== undefined ? update.diffStats ?? undefined : inst.diffStats,
          // currentModel is populated by Phase 2 of createInstance (and any
          // later lifecycle hop that resolves the model). Falls back to the
          // existing value so status-only updates don't wipe it.
          currentModel: update.currentModel ?? inst.currentModel,
          providerSessionId: update.providerSessionId ?? inst.providerSessionId,
          restartEpoch: update.restartEpoch ?? inst.restartEpoch,
          adapterGeneration: update.adapterGeneration ?? inst.adapterGeneration,
          activeTurnId: update.activeTurnId ?? inst.activeTurnId,
          interruptRequestId: update.interruptRequestId ?? inst.interruptRequestId,
          interruptRequestedAt: update.interruptRequestedAt ?? inst.interruptRequestedAt,
          interruptPhase: update.interruptPhase ?? inst.interruptPhase,
          lastTurnOutcome: update.lastTurnOutcome ?? inst.lastTurnOutcome,
          supersededBy: update.supersededBy ?? inst.supersededBy,
          cancelledForEdit: update.cancelledForEdit ?? inst.cancelledForEdit,
          recoveryMethod: update.recoveryMethod ?? inst.recoveryMethod,
          archivedUpToMessageId:
            update.archivedUpToMessageId ?? inst.archivedUpToMessageId,
          historyThreadId: update.historyThreadId ?? inst.historyThreadId,
          ...(update.displayName ? { displayName: update.displayName } : {}),
          ...(update.executionLocation ? { executionLocation: update.executionLocation } : {}),
        });
      }

      return { ...current, instances: newMap };
    });

    // Set unread completion flag on busy→idle/ready/waiting_for_input/error
    if (previousStatus === 'busy' &&
        (newStatus === 'idle' || newStatus === 'ready' ||
         newStatus === 'waiting_for_input' || newStatus === 'error')) {
      if (this.queries.selectedInstanceId() !== update.instanceId) {
        this.stateService.updateInstance(update.instanceId, { hasUnreadCompletion: true });
      }
    }

    // Process queued messages AFTER state is updated
    if (newStatus === 'idle' || newStatus === 'ready' || newStatus === 'waiting_for_input') {
      this.messagingStore.processMessageQueue(update.instanceId);
    }

    // Clear stuck queued messages when instance enters a terminal/fatal state
    if (newStatus === 'failed' || newStatus === 'error' || newStatus === 'terminated' || newStatus === 'cancelled' || newStatus === 'superseded') {
      this.messagingStore.clearQueueWithNotification(update.instanceId);
    }
  }

  private applyBatchUpdates(updates: StateUpdate[]): void {
    // Capture previous statuses BEFORE applying updates
    const previousStatuses = new Map<string, InstanceStatus | undefined>();
    for (const update of updates) {
      const inst = this.stateService.getInstance(update.instanceId);
      previousStatuses.set(update.instanceId, inst?.status);
    }

    // Handle activity clearing, approval clearing, and busy-since tracking
    for (const update of updates) {
      const newStatus = update.status as InstanceStatus | undefined;
      if (newStatus === 'idle' || newStatus === 'ready' || newStatus === 'terminated' || newStatus === 'hibernated') {
        this.activityDebouncer.clearActivity(update.instanceId);
        this.outputStore.flushInstanceOutput(update.instanceId);
      }
      // Clear pending approval count when instance resumes work or is terminated
      if (newStatus === 'busy' || newStatus === 'terminated') {
        this.clearPendingApprovals(update.instanceId);
      }
      if (newStatus) {
        this.updateBusySince(update.instanceId, newStatus);
        this.updateRespawnWatchdog(update.instanceId, newStatus);
      }
    }

    // Update state FIRST so processMessageQueue sees the new statuses
    this.stateService.state.update((current) => {
      const newMap = new Map(current.instances);

      for (const update of updates) {
        const instance = newMap.get(update.instanceId);
        if (instance) {
          const timestamp = Date.now();
          const status = (update.status as InstanceStatus | undefined) || instance.status;
          newMap.set(update.instanceId, {
            ...instance,
            status,
            activityState: update.activityState ?? instance.activityState,
            contextUsage: update.contextUsage || instance.contextUsage,
            lastActivity: timestamp,
            metadata: update.status
              ? this.withStatusTimeline(instance.metadata, status, timestamp)
              : instance.metadata,
            diffStats:
              update.diffStats !== undefined ? update.diffStats ?? undefined : instance.diffStats,
            // Same Phase 2 propagation rationale as in applyUpdate above.
            currentModel: update.currentModel ?? instance.currentModel,
            providerSessionId: update.providerSessionId ?? instance.providerSessionId,
            restartEpoch: update.restartEpoch ?? instance.restartEpoch,
            adapterGeneration: update.adapterGeneration ?? instance.adapterGeneration,
            activeTurnId: update.activeTurnId ?? instance.activeTurnId,
            interruptRequestId: update.interruptRequestId ?? instance.interruptRequestId,
            interruptRequestedAt: update.interruptRequestedAt ?? instance.interruptRequestedAt,
            interruptPhase: update.interruptPhase ?? instance.interruptPhase,
            lastTurnOutcome: update.lastTurnOutcome ?? instance.lastTurnOutcome,
            supersededBy: update.supersededBy ?? instance.supersededBy,
            cancelledForEdit: update.cancelledForEdit ?? instance.cancelledForEdit,
            recoveryMethod: update.recoveryMethod ?? instance.recoveryMethod,
            archivedUpToMessageId:
              update.archivedUpToMessageId ?? instance.archivedUpToMessageId,
            historyThreadId: update.historyThreadId ?? instance.historyThreadId,
            ...(update.displayName ? { displayName: update.displayName } : {}),
            ...(update.executionLocation ? { executionLocation: update.executionLocation } : {}),
          });
        }
      }

      return { ...current, instances: newMap };
    });

    // Set unread completion flags and process message queues
    const selectedId = this.queries.selectedInstanceId();
    for (const update of updates) {
      const newStatus = update.status as InstanceStatus;
      const prevStatus = previousStatuses.get(update.instanceId);

      // Set unread flag on busy→completion transitions
      if (prevStatus === 'busy' &&
          (newStatus === 'idle' || newStatus === 'ready' ||
           newStatus === 'waiting_for_input' || newStatus === 'error')) {
        if (selectedId !== update.instanceId) {
          this.stateService.updateInstance(update.instanceId, { hasUnreadCompletion: true });
        }
      }

      // Process queued messages
      if (newStatus === 'idle' || newStatus === 'ready' || newStatus === 'waiting_for_input') {
        this.messagingStore.processMessageQueue(update.instanceId);
      }

      // Clear stuck queued messages when instance enters a terminal/fatal state
      if (newStatus === 'failed' || newStatus === 'error' || newStatus === 'terminated' || newStatus === 'cancelled' || newStatus === 'superseded') {
        this.messagingStore.clearQueueWithNotification(update.instanceId);
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

  private withStatusTimeline(
    metadata: Record<string, unknown> | undefined,
    status: InstanceStatus,
    timestamp: number,
  ): Record<string, unknown> {
    const current = metadata ?? {};
    const orchestration = this.isRecord(current['orchestration'])
      ? current['orchestration']
      : {};
    const existing = Array.isArray(orchestration['statusTimeline'])
      ? orchestration['statusTimeline'].filter((entry): entry is { status: string; timestamp: number } =>
          this.isRecord(entry)
          && typeof entry['status'] === 'string'
          && typeof entry['timestamp'] === 'number'
        )
      : [];
    const last = existing[existing.length - 1];
    const statusTimeline = last?.status === status
      ? existing
      : [...existing, { status, timestamp }].slice(-100);
    return {
      ...current,
      orchestration: {
        ...orchestration,
        statusTimeline,
      },
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** Get the timestamp when the selected instance became busy (for elapsed time) */
  getSelectedInstanceBusySince(): number | undefined {
    const id = this.queries.selectedInstanceId();
    if (!id) return undefined;
    return this._busySince().get(id);
  }

  // ============================================
  // Respawn Timeout Watchdog
  // ============================================

  /**
   * Start or clear the recovery timeout when status changes.
   * If an instance stays in an interrupt/respawn state for longer than RESPAWN_TIMEOUT_MS,
   * force-terminate it so the user isn't stuck with an unresponsive session.
   */
  private updateRespawnWatchdog(instanceId: string, newStatus: InstanceStatus): void {
    // Clear any existing timer when status changes
    const existing = this.respawnTimers.get(instanceId);
    if (existing) {
      clearTimeout(existing);
      this.respawnTimers.delete(instanceId);
    }

    const isInterruptRecoveryState =
      newStatus === 'respawning'
      || newStatus === 'interrupting'
      || newStatus === 'cancelling'
      || newStatus === 'interrupt-escalating';

    if (isInterruptRecoveryState) {
      const timer = setTimeout(() => {
        this.respawnTimers.delete(instanceId);
        const inst = this.stateService.getInstance(instanceId);
        const stillRecovering = inst
          && (inst.status === 'respawning'
            || inst.status === 'interrupting'
            || inst.status === 'cancelling'
            || inst.status === 'interrupt-escalating');
        if (stillRecovering) {
          console.error('Interrupt recovery timeout: force-terminating stuck instance', { instanceId });
          this.listStore.terminateInstance(instanceId).then(() =>
            this.listStore.restartInstance(instanceId)
          ).catch((err) => {
            console.error('Interrupt recovery timeout recovery failed', err);
          });
        }
      }, InstanceStore.RESPAWN_TIMEOUT_MS);
      this.respawnTimers.set(instanceId, timer);
    }
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
    if (id) {
      const instance = this.stateService.getInstance(id);
      if (instance?.hasUnreadCompletion) {
        this.stateService.updateInstance(id, { hasUnreadCompletion: false });
      }
    }
  }

  /** Create a new instance */
  async createInstance(config: CreateInstanceConfig): Promise<void> {
    return this.listStore.createInstance(config);
  }

  /** Create instance and immediately send a message */
  async createInstanceWithMessage(
    options: CreateInstanceWithMessageOptions,
  ): Promise<boolean> {
    return this.listStore.createInstanceWithMessage(options);
  }

  /** Set an error message */
  setError(error: string | null): void {
    this.stateService.setError(error);
  }

  /** Create a child instance */
  async createChildInstance(parentId: string): Promise<void> {
    return this.listStore.createChildInstance(parentId);
  }

  /**
   * Synchronously add an instance to renderer state from an IPC response payload.
   * Use when an IPC handler (e.g., forkSession) returns a new instance and callers
   * need it present in state before the async 'instance:created' event arrives.
   * Idempotent — the 'instance:created' listener will safely overwrite with the
   * same data when it eventually fires.
   */
  addInstanceFromData(data: unknown): void {
    this.listStore.addInstance(data);
  }

  /** Send input to an instance (queues if busy) */
  async sendInput(instanceId: string, message: string, files?: File[]): Promise<void> {
    return this.messagingStore.sendInput(instanceId, message, files);
  }

  /** Steer the active turn, interrupting once if the provider needs a prompt first. */
  async steerInput(instanceId: string, message: string, files?: File[]): Promise<void> {
    return this.messagingStore.steerInput(instanceId, message, files);
  }

  /** Promote an existing queued message into a steer request. */
  async steerQueuedMessage(instanceId: string, index: number): Promise<void> {
    return this.messagingStore.steerQueuedMessage(instanceId, index);
  }

  /** Terminate an instance */
  async terminateInstance(instanceId: string, graceful = true): Promise<void> {
    return this.listStore.terminateInstance(instanceId, graceful);
  }

  /** Interrupt an instance (Ctrl+C equivalent) */
  async interruptInstance(instanceId: string): Promise<boolean> {
    this.messagingStore.noteInterruptRequested(instanceId);
    return this.listStore.interruptInstance(instanceId);
  }

  /** Restart an instance */
  async restartInstance(instanceId: string): Promise<void> {
    return this.listStore.restartInstance(instanceId);
  }

  /** Restart an instance with fresh context */
  async restartFreshInstance(instanceId: string): Promise<void> {
    return this.listStore.restartFreshInstance(instanceId);
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

  /** Set the restore mode for an instance (called after history restore) */
  setInstanceRestoreMode(instanceId: string, restoreMode: HistoryRestoreMode): void {
    this.listStore.setInstanceRestoreMode(instanceId, restoreMode);
  }

  /** Clear the restore mode for an instance */
  clearInstanceRestoreMode(instanceId: string): void {
    this.listStore.clearInstanceRestoreMode(instanceId);
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
  getMessageQueue(instanceId: string): { message: string; files?: File[]; kind?: 'queue' | 'steer' }[] {
    return this.messagingStore.getMessageQueue(instanceId);
  }

  /** Clear the message queue for an instance */
  clearMessageQueue(instanceId: string): void {
    this.messagingStore.clearMessageQueue(instanceId);
  }

  /** Remove a specific message from the queue and return it */
  removeFromQueue(instanceId: string, index: number): { message: string; files?: File[]; kind?: 'queue' | 'steer' } | null {
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
    const response = await this.instanceIpc.compactInstance(instanceId);
    if (!response.success) {
      console.error('Compaction failed:', response.error?.message);
    }
  }

  /** Decrement pending approval count for an instance (called after approval response) */
  decrementPendingApproval(instanceId: string): void {
    const inst = this.stateService.getInstance(instanceId);
    if (inst && (inst.pendingApprovalCount ?? 0) > 0) {
      this.stateService.updateInstance(instanceId, {
        pendingApprovalCount: (inst.pendingApprovalCount ?? 0) - 1,
      });
    }
  }

  /** Clear all pending approvals for an instance (e.g., when YOLO mode is toggled on) */
  clearPendingApprovals(instanceId: string): void {
    const inst = this.stateService.getInstance(instanceId);
    if (inst && (inst.pendingApprovalCount ?? 0) > 0) {
      this.stateService.updateInstance(instanceId, {
        pendingApprovalCount: 0,
      });
    }
  }
}
