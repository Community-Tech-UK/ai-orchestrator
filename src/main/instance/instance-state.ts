/**
 * Instance State Manager - Manages instance state, adapters, and batch updates
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { BaseCliAdapter } from '../cli/adapters/base-cli-adapter';
import type { SessionDiffTracker } from './session-diff-tracker';
import { InstanceStateMachine } from './instance-state-machine';
import type {
  Instance,
  InstanceStatus,
  InstanceWaitReason,
  ContextUsage,
  SessionDiffStats
} from '../../shared/types/instance.types';
import type {
  InstanceStateUpdatePayload,
  BatchUpdatePayload,
  ErrorInfo
} from '../../shared/types/ipc.types';
import type { InstanceRuntimeSummary } from '../../shared/types/local-model-runtime.types';
import type { ExecutionLocation } from '../../shared/types/worker-node.types';
import type { ActivityState } from '../../shared/types/activity.types';
import { LIMITS } from '../../shared/constants/limits';
import {
  getRecoverySensitiveValues,
  redactRecoveryIdentityValue,
} from './instance-recovery-redaction';

const logger = getLogger('InstanceState');
const RECOVERY_SESSION_OMITTED = '[recovery session omitted]';

function redactRecoveryError(error: ErrorInfo | undefined, instance: Instance): ErrorInfo | undefined {
  if (!error) return undefined;
  return redactRecoveryIdentityValue(
    error,
    getRecoverySensitiveValues(instance),
  ) as ErrorInfo;
}

function redactRecoveryWaitReason(
  waitReason: InstanceWaitReason | null | undefined,
): InstanceWaitReason | null | undefined {
  if (waitReason?.kind !== 'resume-proof') return waitReason;
  return { ...waitReason, sessionId: RECOVERY_SESSION_OMITTED };
}

export class InstanceStateManager extends EventEmitter {
  private instances = new Map<string, Instance>();
  private pendingInstances = new Map<string, Instance>();
  private adapters = new Map<string, CliAdapter>();
  private pendingAdapters = new Map<string, CliAdapter>();
  private diffTrackers = new Map<string, SessionDiffTracker>();
  private stateMachines = new Map<string, InstanceStateMachine>();
  private pendingUpdates = new Map<string, InstanceStateUpdatePayload>();
  private pendingInstanceUpdates = new Map<string, InstanceStateUpdatePayload>();
  private batchTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startBatchTimer();
  }

  // ============================================
  // Instance Accessors
  // ============================================

  /**
   * Get an instance by ID
   */
  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  /** Internal runtime lookup. Pending recovery instances are never returned by public accessors. */
  getRuntimeInstance(id: string): Instance | undefined {
    return this.instances.get(id) ?? this.pendingInstances.get(id);
  }

  /**
   * Check if an instance exists
   */
  hasInstance(id: string): boolean {
    return this.instances.has(id);
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
   * Get the number of instances
   */
  getInstanceCount(): number {
    return this.instances.size;
  }

  getRuntimeInstanceCount(): number {
    return this.instances.size + this.pendingInstances.size;
  }

  /**
   * Store an instance
   */
  setInstance(instance: Instance): void {
    this.instances.set(instance.id, instance);
  }

  setPendingInstance(instance: Instance): void {
    if (this.instances.has(instance.id) || this.pendingInstances.has(instance.id)) {
      throw new Error(`Instance ${instance.id} is already registered`);
    }
    this.pendingInstances.set(instance.id, instance);
  }

  publishPendingInstance(instanceId: string): Instance {
    const instance = this.pendingInstances.get(instanceId);
    if (!instance) throw new Error(`Pending instance ${instanceId} not found`);
    if (this.instances.has(instanceId)) throw new Error(`Instance ${instanceId} is already published`);
    this.pendingInstances.delete(instanceId);
    this.instances.set(instanceId, instance);
    const adapter = this.pendingAdapters.get(instanceId);
    if (adapter) {
      this.pendingAdapters.delete(instanceId);
      this.adapters.set(instanceId, adapter);
    }
    return instance;
  }

  isInstancePublished(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  isInstancePending(instanceId: string): boolean {
    return this.pendingInstances.has(instanceId);
  }

  releasePendingUpdate(instanceId: string): void {
    const update = this.pendingInstanceUpdates.get(instanceId);
    if (!update) return;
    this.pendingInstanceUpdates.delete(instanceId);
    this.pendingUpdates.set(instanceId, update);
  }

  clearPendingInstanceState(instanceId: string): void {
    this.pendingInstanceUpdates.delete(instanceId);
    this.pendingUpdates.delete(instanceId);
  }

  /**
   * Remove an instance
   */
  deleteInstance(id: string): boolean {
    return this.instances.delete(id);
  }

  deleteRuntimeInstance(id: string): boolean {
    this.clearPendingInstanceState(id);
    this.pendingAdapters.delete(id);
    return this.instances.delete(id) || this.pendingInstances.delete(id);
  }

  forEachRuntimeInstance(callback: (instance: Instance, id: string) => void): void {
    this.instances.forEach(callback);
    this.pendingInstances.forEach(callback);
  }

  /**
   * Iterate over all instances
   */
  forEachInstance(callback: (instance: Instance, id: string) => void): void {
    this.instances.forEach(callback);
  }

  // ============================================
  // Adapter Accessors
  // ============================================

  /**
   * Get an adapter by instance ID
   */
  getAdapter(instanceId: string): CliAdapter | undefined {
    return this.adapters.get(instanceId);
  }

  getRuntimeAdapter(instanceId: string): CliAdapter | undefined {
    return this.adapters.get(instanceId) ?? this.pendingAdapters.get(instanceId);
  }

  /**
   * Check if an adapter exists
   */
  hasAdapter(instanceId: string): boolean {
    return this.adapters.has(instanceId);
  }

  /**
   * Store an adapter
   */
  setAdapter(instanceId: string, adapter: CliAdapter): void {
    logger.debug('setAdapter called', { instanceId });
    const store = this.pendingInstances.has(instanceId) ? this.pendingAdapters : this.adapters;
    store.set(instanceId, adapter);
    logger.debug('Adapter stored', { instanceId, adapterCount: store.size });
  }

  /**
   * Remove an adapter
   */
  deleteAdapter(instanceId: string): boolean {
    logger.debug('deleteAdapter called', { instanceId });
    return this.adapters.delete(instanceId);
  }

  deleteRuntimeAdapter(instanceId: string): boolean {
    logger.debug('deleteRuntimeAdapter called', { instanceId });
    return this.adapters.delete(instanceId) || this.pendingAdapters.delete(instanceId);
  }

  /**
   * Get all adapter entries for iteration
   */
  getAdapterEntries(): IterableIterator<[string, CliAdapter]> {
    return this.adapters.entries();
  }

  // ============================================
  // Diff Tracker Accessors
  // ============================================

  /**
   * Get the SessionDiffTracker for an instance
   */
  getDiffTracker(instanceId: string): SessionDiffTracker | undefined {
    return this.diffTrackers.get(instanceId);
  }

  /**
   * Store a SessionDiffTracker for an instance
   */
  setDiffTracker(instanceId: string, tracker: SessionDiffTracker): void {
    this.diffTrackers.set(instanceId, tracker);
  }

  /**
   * Remove the SessionDiffTracker for an instance
   */
  deleteDiffTracker(instanceId: string): void {
    this.diffTrackers.delete(instanceId);
  }

  // ============================================
  // State Machine Accessors
  // ============================================

  /**
   * Get the InstanceStateMachine for an instance
   */
  getStateMachine(instanceId: string): InstanceStateMachine | undefined {
    return this.stateMachines.get(instanceId);
  }

  /**
   * Create and store an InstanceStateMachine for an instance
   */
  setStateMachine(instanceId: string, machine: InstanceStateMachine): void {
    this.stateMachines.set(instanceId, machine);
  }

  /**
   * Remove the InstanceStateMachine for an instance
   */
  deleteStateMachine(instanceId: string): void {
    this.stateMachines.delete(instanceId);
  }

  // ============================================
  // Batch Update System
  // ============================================

  /**
   * Queue a state update for batching
   */
  queueUpdate(
    instanceId: string,
    status: InstanceStatus,
    contextUsage?: ContextUsage,
    diffStats?: SessionDiffStats | null,
    displayName?: string,
    error?: ErrorInfo,
    executionLocation?: ExecutionLocation,
    sessionState?: {
      providerSessionId?: string;
      restartEpoch?: number;
      adapterGeneration?: number;
      activeTurnId?: string;
      interruptRequestId?: string;
      interruptRequestedAt?: number;
      interruptPhase?: Instance['interruptPhase'];
      lastTurnOutcome?: Instance['lastTurnOutcome'];
      supersededBy?: string;
      cancelledForEdit?: boolean;
      recoveryMethod?: Instance['recoveryMethod'];
      archivedUpToMessageId?: string;
      historyThreadId?: string;
    },
    activityState?: ActivityState,
    /**
     * Resolved model id from Phase 2 of `createInstance` (or any later
     * lifecycle hop where the model changes). Most callers omit this; pass
     * it explicitly when announcing a newly-resolved model so the renderer
     * can stop falling back to `availableModels[0]?.id`.
     */
    currentModel?: string,
    /**
     * Machine-readable wait reason (Phase 6 / §G). Pass the reason when entering
     * a long-wait status; pass `null` to explicitly clear it on idle/busy/ready.
     * Omit (undefined) to preserve the previous value.
     */
    waitReason?: InstanceWaitReason | null,
    /**
     * Rare fields grouped into an options bag rather than extending the
     * positional tail: `provider` announces a cross-provider swap;
     * `desiredRuntime` broadcasts a queued (or cleared, via null)
     * while-busy runtime change. Omitted fields preserve pending values.
     */
    extras?: {
      provider?: Instance['provider'];
      desiredRuntime?: Instance['desiredRuntime'] | null;
    },
  ): void {
    const updateStore = this.pendingInstances.has(instanceId)
      ? this.pendingInstanceUpdates
      : this.pendingUpdates;
    const existing = updateStore.get(instanceId);
    const runtimeInstance = this.getRuntimeInstance(instanceId);
    const isCrashRecovery = runtimeInstance?.metadata?.['reason'] === 'crash-recovery';
    const nextError = error ?? existing?.error;
    const nextWaitReason = waitReason !== undefined ? waitReason : existing?.waitReason;
    const safeError = isCrashRecovery && runtimeInstance
      ? redactRecoveryError(nextError, runtimeInstance)
      : nextError;
    const safeWaitReason = isCrashRecovery
      ? redactRecoveryWaitReason(nextWaitReason)
      : nextWaitReason;
    const runtimeSummary: InstanceRuntimeSummary | null | undefined =
      currentModel !== undefined
        ? runtimeInstance?.runtimeSummary ?? null
        : existing?.runtimeSummary;
    // LT-160: unlike status/contextUsage/desiredRuntime — which every caller
    // also assigns directly onto the live Instance object in addition to
    // routing here for the renderer broadcast — waitReason had no such direct
    // writer anywhere. It only ever reached `pendingUpdates` (renderer-bound),
    // so the canonical Instance object's own `waitReason` stayed permanently
    // undefined. Main-process readers that gate on it synchronously
    // (SessionAdmissionService.admitAutomatedWrite, the mobile input queue)
    // were therefore structurally blind to every quota-park / auth-required
    // wait state. Mirror the same live-object write here, the one function
    // every waitReason caller already funnels through.
    if (waitReason !== undefined) {
      if (runtimeInstance) {
        runtimeInstance.waitReason = safeWaitReason ?? undefined;
      }
    }
    updateStore.set(instanceId, {
      instanceId,
      status,
      activityState: activityState ?? existing?.activityState,
      contextUsage: contextUsage ?? existing?.contextUsage,
      diffStats: diffStats !== undefined ? diffStats : existing?.diffStats,
      displayName: displayName ?? existing?.displayName,
      error: safeError,
      executionLocation: executionLocation ?? existing?.executionLocation,
      currentModel: currentModel ?? existing?.currentModel,
      runtimeSummary,
      providerSessionId: isCrashRecovery
        ? undefined
        : sessionState?.providerSessionId ?? existing?.providerSessionId,
      restartEpoch: sessionState?.restartEpoch ?? existing?.restartEpoch,
      adapterGeneration: sessionState?.adapterGeneration ?? existing?.adapterGeneration,
      activeTurnId: sessionState?.activeTurnId ?? existing?.activeTurnId,
      interruptRequestId: sessionState?.interruptRequestId ?? existing?.interruptRequestId,
      interruptRequestedAt: sessionState?.interruptRequestedAt ?? existing?.interruptRequestedAt,
      interruptPhase: sessionState?.interruptPhase ?? existing?.interruptPhase,
      lastTurnOutcome: sessionState?.lastTurnOutcome ?? existing?.lastTurnOutcome,
      supersededBy: sessionState?.supersededBy ?? existing?.supersededBy,
      cancelledForEdit: sessionState?.cancelledForEdit ?? existing?.cancelledForEdit,
      recoveryMethod: sessionState?.recoveryMethod ?? existing?.recoveryMethod,
      archivedUpToMessageId:
        sessionState?.archivedUpToMessageId ?? existing?.archivedUpToMessageId,
      historyThreadId: isCrashRecovery
        ? undefined
        : sessionState?.historyThreadId ?? existing?.historyThreadId,
      // waitReason: null clears it; undefined preserves existing.
      waitReason: safeWaitReason,
      provider: extras?.provider ?? existing?.provider,
      // desiredRuntime: null clears it; undefined preserves existing.
      desiredRuntime:
        extras?.desiredRuntime !== undefined
          ? extras.desiredRuntime
          : existing?.desiredRuntime,
    });
  }

  /**
   * Whether the instance's adapter self-manages context auto-compaction
   * (Claude CLI always; Codex in app-server mode). Read lazily from the live
   * adapter so it reflects the mode resolved after spawn — do NOT cache it at
   * setAdapter() time, where Codex's app-server mode is not yet detected.
   * Returns undefined when no adapter is attached yet so callers can preserve
   * the renderer's existing value rather than clobbering it with a stale false.
   */
  private getSelfManagesAutoCompaction(instanceId: string): boolean | undefined {
    const adapter = this.adapters.get(instanceId);
    if (!adapter) return undefined;
    return adapter instanceof BaseCliAdapter
      ? adapter.getRuntimeCapabilities().selfManagedAutoCompaction
      : false;
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

    const updates = Array.from(this.pendingUpdates.values()).map((update) => {
      const selfManaged = this.getSelfManagesAutoCompaction(update.instanceId);
      return selfManaged === undefined
        ? update
        : { ...update, selfManagesAutoCompaction: selfManaged };
    });
    this.pendingUpdates.clear();

    const batchPayload: BatchUpdatePayload = {
      updates,
      timestamp: Date.now()
    };

    this.emit('batch-update', batchPayload);
  }

  // ============================================
  // Serialization
  // ============================================

  /**
   * Serialize instance for IPC (convert Maps to Objects).
   *
   * Strips non-cloneable properties (Promises, AbortController) that would
   * cause V8 structured-clone to throw a DataCloneError when sent via
   * webContents.send() or ipcMain.handle().
   */
  serializeForIpc(instance: Instance): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {
      readyPromise,
      respawnPromise,
      abortController,
      communicationTokens,
      sessionId,
      providerSessionId,
      historyThreadId,
      rlmStoreSessionId,
      metadata,
      waitReason,
      ...rest
    } = instance;
    const isCrashRecovery = metadata?.['reason'] === 'crash-recovery';
    const selfManaged = this.getSelfManagesAutoCompaction(instance.id);
    return {
      ...rest,
      communicationTokens: Object.fromEntries(communicationTokens),
      ...(!isCrashRecovery && sessionId !== undefined ? { sessionId } : {}),
      ...(!isCrashRecovery && providerSessionId !== undefined ? { providerSessionId } : {}),
      ...(!isCrashRecovery && historyThreadId !== undefined ? { historyThreadId } : {}),
      ...(!isCrashRecovery && rlmStoreSessionId !== undefined ? { rlmStoreSessionId } : {}),
      ...(waitReason !== undefined
        ? {
            waitReason: isCrashRecovery
              ? redactRecoveryWaitReason(waitReason)
              : waitReason,
          }
        : {}),
      ...(metadata !== undefined
        ? {
            metadata: isCrashRecovery
              ? {
                  reason: 'crash-recovery',
                  ...(metadata['continuityRevival'] === true ? { continuityRevival: true } : {}),
                }
              : metadata,
          }
        : {}),
      ...(selfManaged !== undefined ? { selfManagesAutoCompaction: selfManaged } : {}),
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Stop batch timer on shutdown
   */
  destroy(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    // Flush any remaining updates
    this.flushUpdates();
    this.pendingInstances.clear();
    this.pendingAdapters.clear();
    this.pendingInstanceUpdates.clear();
    this.stateMachines.clear();
  }
}
