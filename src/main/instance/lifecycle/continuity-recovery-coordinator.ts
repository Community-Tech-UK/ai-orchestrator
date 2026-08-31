import type {
  Instance,
  InstanceCreateConfig,
  InstanceStatus,
} from '../../../shared/types/instance.types';
import type { RecoverSessionResult } from '../../../shared/types/session-recovery.types';
import { getLogger } from '../../logging/logger';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import { emitPluginHook } from '../../plugins/hook-emitter';
import { addAllowedRoot } from '../../security/path-validator';
import { getSessionContinuityManager } from '../../session/session-continuity';
import {
  getRecoveryIdentityKeys,
  getSessionRecoveryCandidateServiceIfInitialized,
  type ResolvedRecoveryCandidate,
} from '../../session/session-recovery-candidate-service';
import { getCanonicalRecoveryKey } from '../../session/recoverable-session-selection';
import type { UnpublishedInstanceCreation } from '../instance-lifecycle';
import {
  getResourceGovernorCreationBlockReason,
  sanitizeCreateConfig,
} from '../instance-manager-logging';
import { dispatchInstanceLifecycleHook } from '../instance-lifecycle-hooks';
import {
  clearExtraRecoverySensitiveValues,
  clearPendingRecoveryAdapterExit,
  getPendingRecoveryAdapterExit,
  setExtraRecoverySensitiveValues,
} from '../instance-recovery-redaction';
import {
  reviveContinuitySession,
  type ContinuityRecoveryCreation,
} from './continuity-revival';

const logger = getLogger('ContinuityRecoveryCoordinator');
const RECOVERY_NON_LIVE_STATUSES = new Set<InstanceStatus>([
  'terminated', 'failed', 'error', 'cancelled', 'superseded', 'hibernated',
]);

export interface ContinuityRecoveryCoordinatorDependencies {
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  createUnpublishedInstance(config: InstanceCreateConfig): Promise<UnpublishedInstanceCreation>;
  getAllInstances(): readonly Instance[];
  queueContinuityPreamble(instanceId: string, preamble: string): void;
  clearPrivateState(instanceId: string): void;
}

/** Owns private crash-recovery startup, publication, rollback, and live source aliases. */
export class ContinuityRecoveryCoordinator {
  private readonly recoveryIdentityKeysByInstanceId = new Map<string, ReadonlySet<string>>();

  constructor(private readonly deps: ContinuityRecoveryCoordinatorDependencies) {}

  removeInstance(instanceId: string): void {
    this.recoveryIdentityKeysByInstanceId.delete(instanceId);
  }

  getLiveRecoveryKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const instance of this.deps.getAllInstances()) {
      if (RECOVERY_NON_LIVE_STATUSES.has(instance.status)) continue;
      for (const key of getRecoveryIdentityKeys({
        recoveryKey: getCanonicalRecoveryKey({
          instanceId: instance.id,
          provider: instance.provider,
          historyThreadId: instance.historyThreadId,
          sessionId: instance.sessionId,
        }),
        provider: instance.provider,
        historyThreadId: instance.historyThreadId,
        sessionId: instance.sessionId,
        sourceInstanceId: instance.id,
      })) {
        keys.add(key);
      }
      for (const key of this.recoveryIdentityKeysByInstanceId.get(instance.id) ?? []) {
        keys.add(key);
      }
    }
    return keys;
  }

  /** Internal-only aliases used to scrub recovery identity from runtime telemetry. */
  getRecoveryIdentityKeysForInstance(instanceId: string): ReadonlySet<string> {
    return this.recoveryIdentityKeysByInstanceId.get(instanceId) ?? new Set<string>();
  }

  async recover(resolvedCandidate: ResolvedRecoveryCandidate): Promise<RecoverSessionResult> {
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('Session recovery refused while orchestrator is paused');
    }
    const revived = await reviveContinuitySession({
      resumeSession: (instanceId, options) =>
        getSessionContinuityManager().resumeSession(instanceId, options),
      createInstance: (config) => this.deps.createInstance(config),
      createRecoveryInstance: (config) => this.createRecoveryInstance(config, resolvedCandidate),
      queueContinuityPreamble: (instanceId, preamble) =>
        this.deps.queueContinuityPreamble(instanceId, preamble),
      now: () => Date.now(),
    }, {
      sourceInstanceId: resolvedCandidate.candidate.sourceInstanceId,
      reason: 'crash-recovery',
      resolvedCandidate,
    });
    getSessionRecoveryCandidateServiceIfInitialized()?.invalidate();
    return {
      instanceId: revived.instanceId,
      recoveredMessageCount: revived.recoveredMessageCount ?? 0,
      usedNativeResume: revived.restoreMode === 'native',
    };
  }

  private async createRecoveryInstance(
    config: InstanceCreateConfig,
    resolvedCandidate: ResolvedRecoveryCandidate,
  ): Promise<ContinuityRecoveryCreation> {
    const creationBlockReason = getResourceGovernorCreationBlockReason();
    if (creationBlockReason) {
      logger.warn('Refusing to recover instance while resource governor blocks creation', {
        reason: creationBlockReason,
        config: sanitizeCreateConfig(config),
      });
      throw new Error(`Instance creation is paused by the resource governor (${creationBlockReason}).`);
    }
    if (config.workingDirectory) addAllowedRoot(config.workingDirectory);

    const creation = await this.deps.createUnpublishedInstance(config);
    const instance = creation.instance;
    const sourceIdentityKeys = this.buildSourceIdentityKeys(resolvedCandidate);
    setExtraRecoverySensitiveValues(instance, sourceIdentityKeys);
    let state: 'pending' | 'publishing' | 'published' | 'publication-failed'
      | 'rolling-back' | 'rolled-back' = 'pending';
    let trackingOwned = false;
    let publicationPromise: Promise<void> | undefined;
    let rollbackPromise: Promise<void> | undefined;
    const discardPrivateTracking = async (): Promise<void> => {
      if (!trackingOwned) return;
      try {
        await getSessionContinuityManager().discardTracking(instance.id);
        trackingOwned = false;
      } catch {
        logger.warn('Recovery continuity cleanup failed', {
          instanceId: instance.id,
          recoverySession: true,
        });
      }
    };

    const runPublicationObservers = (): void => {
      const observers: Array<() => void> = [
        () => emitPluginHook('instance.spawn.before', {
          parentId: config.parentId ?? null,
          displayName: config.displayName,
          workingDirectory: config.workingDirectory,
          requestedProvider: config.provider,
          requestedModel: config.modelOverride,
          agentId: config.agentId,
          config: sanitizeCreateConfig(config),
          timestamp: Date.now(),
        }),
        () => emitPluginHook('instance.spawn.after', {
          instanceId: instance.id,
          parentId: instance.parentId,
          displayName: instance.displayName,
          workingDirectory: instance.workingDirectory,
          requestedProvider: config.provider,
          requestedModel: config.modelOverride,
          actualProvider: instance.provider,
          actualModel: instance.currentModel,
          agentId: instance.agentId,
          success: true,
          timestamp: Date.now(),
        }),
        () => dispatchInstanceLifecycleHook('SessionStart', instance, {
          stopReason: 'ready',
        }, logger),
      ];
      for (const observer of observers) {
        try {
          observer();
        } catch {
          logger.warn('Optional recovery publication observer failed', {
            instanceId: instance.id,
            recoverySession: true,
          });
        }
      }
    };
    const assertAdapterStillPublishable = (): void => {
      const exit = getPendingRecoveryAdapterExit(instance);
      if (!exit) return;
      throw new Error('Pending recovery adapter exited before publication');
    };

    return {
      instance,
      publish: (): Promise<void> => {
        if (state === 'published') return Promise.resolve();
        if (state === 'publishing' && publicationPromise) return publicationPromise;
        if (state === 'rolling-back' || state === 'rolled-back') {
          return Promise.reject(new Error('Cannot publish a rolled-back recovery instance'));
        }
        state = 'publishing';
        publicationPromise = (async () => {
          try {
            assertAdapterStillPublishable();
            trackingOwned = true;
            await getSessionContinuityManager().startTracking(instance);
            assertAdapterStillPublishable();
            this.recoveryIdentityKeysByInstanceId.set(instance.id, sourceIdentityKeys);
            await creation.publish();
            runPublicationObservers();
            state = 'published';
          } catch (error) {
            this.recoveryIdentityKeysByInstanceId.delete(instance.id);
            clearPendingRecoveryAdapterExit(instance);
            await discardPrivateTracking();
            state = 'publication-failed';
            throw error;
          }
        })();
        return publicationPromise;
      },
      rollback: (cause: unknown): Promise<void> => {
        if (state === 'published' || state === 'rolled-back') return Promise.resolve();
        if (state === 'publishing') {
          return Promise.reject(new Error('Cannot roll back while recovery publication is in progress'));
        }
        if (state === 'rolling-back' && rollbackPromise) return rollbackPromise;
        state = 'rolling-back';
        rollbackPromise = (async () => {
          try {
            await creation.rollback(new Error('Recovery runtime rollback'));
          } catch {
            logger.warn('Recovery runtime rollback failed', {
              instanceId: instance.id,
              recoverySession: true,
            });
          }
          this.recoveryIdentityKeysByInstanceId.delete(instance.id);
          clearPendingRecoveryAdapterExit(instance);
          clearExtraRecoverySensitiveValues(instance);
          await discardPrivateTracking();
          try {
            this.deps.clearPrivateState(instance.id);
          } catch {
            logger.warn('Recovery private-state cleanup failed', {
              instanceId: instance.id,
              recoverySession: true,
            });
          }
          state = 'rolled-back';
          void cause;
        })();
        return rollbackPromise;
      },
    };
  }

  private buildSourceIdentityKeys(
    resolvedCandidate: ResolvedRecoveryCandidate,
  ): ReadonlySet<string> {
    const state = resolvedCandidate.continuityState;
    const provider = state.provider ?? resolvedCandidate.candidate.provider;
    const sourceIdentityKeys = new Set(getRecoveryIdentityKeys({
      recoveryKey: resolvedCandidate.candidate.recoveryKey,
      provider,
      historyThreadId: state.historyThreadId ?? resolvedCandidate.candidate.historyThreadId,
      sessionId: state.sessionId,
      sourceInstanceId: resolvedCandidate.candidate.sourceInstanceId,
    }));
    sourceIdentityKeys.add(getCanonicalRecoveryKey({
      instanceId: state.instanceId,
      provider,
      historyThreadId: state.historyThreadId ?? resolvedCandidate.candidate.historyThreadId,
      resumeCursor: state.resumeCursor,
      sessionId: state.sessionId,
    }));
    const archivedSessionId = resolvedCandidate.historyConversation?.entry.sessionId;
    if (archivedSessionId?.trim()) {
      sourceIdentityKeys.add(`session:${provider}:${archivedSessionId.trim()}`);
    }
    return sourceIdentityKeys;
  }
}
