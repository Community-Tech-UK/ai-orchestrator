/**
 * Types for the RuntimeReconciler — the single owner of runtime changes
 * (provider/model/effort/yolo today; recovery respawns migrate here in
 * follow-ups, see docs/superpowers/specs/2026-07-16-runtime-reconciler-migration_spec_planned.md).
 */

import type { CliAdapter, UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';
import type { CliType } from '../../cli/cli-detection';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type {
  DesiredRuntime,
  Instance,
  InstanceProvider,
  InstanceStatus,
} from '../../../shared/types/instance.types';
import type { AppSettings } from '../../../shared/types/settings.types';
import type { ReasoningEffort } from '../../../shared/types/provider.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { ModelSelectionDegradation } from './model-selection-degradation';
import type { SpawnConfigBuilder } from './spawn-config-builder';

export type { DesiredRuntime };

/** Which parts of the runtime the desired state actually changes. Pure data. */
export interface RuntimeDiff {
  providerChanged: boolean;
  modelChanged: boolean;
  reasoningChanged: boolean;
  runtimeTargetChanged: boolean;
  yoloModeChanged: boolean;
  hasChanges: boolean;
}

/**
 * How conversation context survives the runtime change:
 *   - 'native-resume-fork': resume the provider session into a forked session id
 *   - 'native-resume': resume the provider session in place
 *   - 'replay': fresh session; context carried via the replay-continuity preamble
 */
export type ContinuityPlan = 'native-resume-fork' | 'native-resume' | 'replay';

/** The two adapter capabilities the continuity plan depends on. */
export interface RuntimeAdapterCapabilities {
  supportsResume: boolean;
  supportsForkSession: boolean;
}

/**
 * Spec item 2 (interrupt-respawn migration): the mechanical spawn request the
 * recovery orchestrator hands to {@link RuntimeReconciler.applyRecoveryRespawn}.
 * The orchestrator (InterruptRespawnHandler) keeps everything recovery-*specific*
 * — circuit breaker, session-lock acquisition with rich metadata, abort
 * decisions, `planSessionRecovery`, interrupt phases, and post-respawn
 * bookkeeping. The reconciler owns the incident-hardened terminate-free spawn
 * core: spawn → resume-health → fresh-fallback ordering →
 * `writeThroughIdentityLocked` → continuity delivery.
 */
export interface RecoveryRespawnRequest {
  cliType: CliType;
  /** Fully built options for the primary attempt (resume/fork/sessionId set). */
  spawnOptions: UnifiedSpawnOptions;
  shouldResume: boolean;
  hasConversation: boolean;
  /**
   * Provider session id to record after a successful primary spawn. For a
   * provider-fork this is the NEW forked id, while `spawnOptions.sessionId`
   * stays the id being resumed FROM — they intentionally differ.
   */
  postSpawnProviderSessionId: string;
  /** Reason string for the replay-continuity preamble (e.g. 'interrupt-respawn'). */
  replayReason: string;
  /**
   * Reason string for the fallback transcript history when a native resume
   * fails ('resume-failed-fallback' for interrupts, 'auto-respawn-fallback'
   * for unexpected exits).
   */
  fallbackReason: string;
}

/**
 * Recovery-specific behavior injected by the orchestrator. Kept deliberately
 * small: everything generic lives on the reconciler's own deps.
 */
export interface RecoveryRespawnHooks {
  /** Re-checked at every hardened abort point (the A7/terminated-mid-respawn race class). */
  shouldAbort(): boolean;
  /** Clean up an adapter created for a respawn that was aborted mid-flight. */
  onAborted(adapter: CliAdapter, note: string): Promise<void>;
  /** Post-spawn readiness wait (the recovery paths use adapter-writable, not the input boundary). */
  waitReady(adapter: CliAdapter): Promise<unknown>;
  /**
   * Deliver a continuity payload — either queue it for the next user turn or
   * send it inline. Returns true when it was sent inline (recovery input),
   * which the orchestrator uses to decide the post-respawn status.
   */
  deliverContinuity(adapter: CliAdapter, text: string): Promise<boolean>;
}

export type RecoveryRespawnOutcome =
  | { status: 'aborted' }
  | {
      status: 'ok';
      pid: number;
      adapter: CliAdapter;
      actuallyResumed: boolean;
      recoveryInputSent: boolean;
      sessionId: string;
    };

/**
 * Closures into the lifecycle manager. The reconciler owns the change flow;
 * the lifecycle keeps ownership of state transitions, adapter registration,
 * readiness checks, and event emission.
 */
export interface RuntimeReconcilerDeps {
  getInstance(instanceId: string): Instance | undefined;
  getAdapter(instanceId: string): CliAdapter | undefined;
  setAdapter(instanceId: string, adapter: CliAdapter): void;
  deleteAdapter(instanceId: string): boolean;
  setupAdapterEvents(instanceId: string, adapter: CliAdapter): void;
  transitionState(instance: Instance, status: InstanceStatus): void;
  resolveCliTypeForInstance(instance: Instance): Promise<CliType>;
  getAdapterRuntimeCapabilities(adapter?: CliAdapter): RuntimeAdapterCapabilities;
  assertLocalModelRuntimeAvailable(
    target: Extract<NonNullable<Instance['modelRuntimeTarget']>, { kind: 'local-model' }>,
  ): Promise<void>;
  residentClaudeForSpawn(instance: Instance): boolean;
  createRuntimeAdapter(
    cliType: CliType,
    options: UnifiedSpawnOptions,
    executionLocation?: ExecutionLocation,
  ): CliAdapter;
  waitForResumeHealth(instanceId: string): Promise<boolean>;
  waitForInputReadinessBoundary(instanceId: string, adapter: CliAdapter): Promise<void>;
  prepareStatusForAdapterInput(instance: Instance): void;
  buildReplayContinuityMessage(instance: Instance, reason: string): string;
  buildFallbackHistory(instance: Instance, reason: string): Promise<string>;
  emitModelSelectionDegradation(instance: Instance, degradation: ModelSelectionDegradation): void;
  emitRuntimeChanged(payload: {
    instanceId: string;
    model?: string;
    provider: InstanceProvider;
    reasoningEffort?: ReasoningEffort | null;
  }): void;
  /** Emitted whenever `yoloMode` changes (applied or still queued) — renderer live push. */
  emitYoloToggled(payload: {
    instanceId: string;
    yoloMode: boolean;
    pendingYoloMode?: boolean;
  }): void;
  getSettings(): AppSettings;
  spawnConfigBuilder: SpawnConfigBuilder;
  queueUpdate: LifecycleDependencies['queueUpdate'];
}
