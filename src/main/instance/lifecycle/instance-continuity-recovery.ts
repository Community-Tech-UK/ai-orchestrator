import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { RecoverSessionResult } from '../../../shared/types/session-recovery.types';
import type { PendingEnvelope } from '../../providers/provider-runtime-event-bus';
import { getLogger } from '../../logging/logger';
import { getHandoffStateService } from '../../session/handoff-state-service';
import type { ResolvedRecoveryCandidate } from '../../session/session-recovery-candidate-service';
import { ContinuityRecoveryCoordinator } from './continuity-recovery-coordinator';
import type { UnpublishedInstanceCreation } from './unpublished-instance-creation';
import {
  getRecoverySensitiveValues,
  redactRecoveryIdentityValue,
} from '../instance-recovery-redaction';

const logger = getLogger('InstanceContinuityRecovery');

interface InstanceContinuityRecoveryDeps {
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  createUnpublishedInstance(config: InstanceCreateConfig): Promise<UnpublishedInstanceCreation>;
  getAllInstances(): Instance[];
  getInstance(instanceId: string): Instance | undefined;
  queueContinuityPreamble(instanceId: string, preamble: string): void;
  clearCommunication(instanceId: string): void;
  clearPendingState(instanceId: string): void;
  removeProviderEvents(instanceId: string): void;
  clearSettledState(instanceId: string): void;
}

/** Manager-facing owner for recovery lifecycle, aliases, cleanup, and event redaction. */
export class InstanceContinuityRecovery {
  private readonly coordinator: ContinuityRecoveryCoordinator;

  constructor(private readonly deps: InstanceContinuityRecoveryDeps) {
    this.coordinator = new ContinuityRecoveryCoordinator({
      createInstance: deps.createInstance,
      createUnpublishedInstance: deps.createUnpublishedInstance,
      getAllInstances: deps.getAllInstances,
      queueContinuityPreamble: deps.queueContinuityPreamble,
      clearPrivateState: (instanceId) => this.clearPrivateState(instanceId),
    });
  }

  recover(candidate: ResolvedRecoveryCandidate): Promise<RecoverSessionResult> {
    return this.coordinator.recover(candidate);
  }

  getLiveRecoveryKeys(): ReadonlySet<string> {
    return this.coordinator.getLiveRecoveryKeys();
  }

  getRecoveryIdentityKeysForInstance(instanceId: string): ReadonlySet<string> {
    return this.coordinator.getRecoveryIdentityKeysForInstance(instanceId);
  }

  removeInstance(instanceId: string): void {
    this.coordinator.removeInstance(instanceId);
  }

  redactProviderEnvelope(pending: PendingEnvelope): PendingEnvelope {
    const instance = this.deps.getInstance(pending.instanceId);
    if (instance?.metadata?.['reason'] !== 'crash-recovery') return pending;

    const sensitiveValues = getRecoverySensitiveValues(instance);
    for (const key of this.coordinator.getRecoveryIdentityKeysForInstance(instance.id)) {
      sensitiveValues.add(key);
      const providerSeparator = key.indexOf(':', key.indexOf(':') + 1);
      if (providerSeparator >= 0 && providerSeparator + 1 < key.length) {
        sensitiveValues.add(key.slice(providerSeparator + 1));
      }
    }

    const { sessionId: _sessionId, raw: _raw, ...safePending } = pending;
    return {
      ...safePending,
      event: redactRecoveryIdentityValue(pending.event, sensitiveValues) as ProviderRuntimeEvent,
    };
  }

  private clearPrivateState(instanceId: string): void {
    const cleanupOwners: Array<readonly [string, () => void]> = [
      ['communication', () => this.deps.clearCommunication(instanceId)],
      ['pending-state', () => this.deps.clearPendingState(instanceId)],
      ['provider-events', () => this.deps.removeProviderEvents(instanceId)],
      ['settled-state', () => this.deps.clearSettledState(instanceId)],
      ['handoff-state', () => getHandoffStateService().removeInstance(instanceId)],
    ];
    for (const [owner, cleanup] of cleanupOwners) {
      try {
        cleanup();
      } catch {
        logger.warn('Recovery private cleanup owner failed', {
          instanceId,
          owner,
          recoverySession: true,
        });
      }
    }
  }
}
