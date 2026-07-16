/**
 * Types for the RuntimeReconciler — the single owner of runtime changes
 * (provider/model/effort swaps today; yolo/recovery respawns migrate here in
 * follow-ups, see docs/superpowers/specs/2026-07-16-runtime-reconciler-migration_spec.md).
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
 * Closures into the lifecycle manager. The reconciler owns the change flow;
 * the lifecycle keeps ownership of state transitions, adapter registration,
 * readiness checks, and event emission (same wiring pattern as YoloModeQueue).
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
  getSettings(): AppSettings;
  spawnConfigBuilder: SpawnConfigBuilder;
  queueUpdate: LifecycleDependencies['queueUpdate'];
}
